/**
 * downloadManager — 主进程层
 *
 * 职责：
 * - 下载任务的完整生命周期管理（创建、暂停、恢复、重试、删除）
 * - 并发控制（p-queue）+ 进度节流广播
 * - DB 持久化 + 启动恢复未完成任务
 * - IPC 注册
 */
import { ipcMain } from 'electron';
import PQueue from 'p-queue';
import { nanoid } from 'nanoid';
import path from 'path';
import fsp from 'fs/promises';
import type { IDbStatement, IDbTransaction, IDatabaseProvider } from '@appTypes/infra/database';
import throttle, { type IThrottledFunction } from '@common/throttle';
import { QUALITY_KEYS, INTERNAL_SLIM_KEY } from '@common/constant';
import sanitizeFileName from '@common/sanitizeFileName';
import { safeParse, safeStringify } from '@common/safeSerialize';
import i18n from '@infra/i18n/main';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type { IAppConfigReader } from '@appTypes/infra/appConfig';
import type {
    IDownloadTask,
    IDownloadTaskRow,
    IDownloadProgress,
    DownloadStatus,
    IPluginManagerForDownload,
    IDownloadedSheetProvider,
    IAddDownloadParams,
} from '@appTypes/infra/downloadManager';
import type { IMusicItemSlim, IMusicItemProvider } from '@appTypes/infra/musicSheet';
import type { IMediaMetaProvider } from '@appTypes/infra/mediaMeta';
import type { ILocalFileLookupFn } from '@appTypes/infra/localMusic';
import { IPC } from '../common/constant';
import { DownloadTask } from './downloadTask';

/** DB 行 snake_case → 业务对象 camelCase */
function rowToTask(row: IDownloadTaskRow): IDownloadTask {
    return {
        id: row.id,
        platform: row.platform,
        musicId: row.music_id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        quality: row.quality as IMusic.IQualityKey,
        status: row.status as DownloadStatus,
        filePath: row.file_path,
        tempPath: row.temp_path,
        totalBytes: row.total_bytes,
        downloadedBytes: row.downloaded_bytes,
        mediaSource: row.media_source,
        musicItemRaw: row.music_item_raw,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

interface IQueries {
    insertTask: IDbStatement;
    updateStatus: IDbStatement;
    getTaskById: IDbStatement;
    getTaskByMusic: IDbStatement;
    getTasksPaginated: IDbStatement;
    getAllTasksUnpaginated: IDbStatement;
    getTaskCount: IDbStatement;
    deleteTask: IDbStatement;
    findExistingActive: IDbStatement;
    recoverTasks: IDbStatement;
    getPausedTasks: IDbStatement;
    getPendingTaskIds: IDbStatement;
}

class DownloadManager {
    private isSetup = false;

    /** 下载落盘后的回调（用于让本地音乐立即重扫） */
    private onFileDownloaded: (() => void) | null = null;

    /** 本地文件被删除后的回调（用于同步清理本地音乐库记录） */
    private onFileDeleted: ((filePath: string) => void) | null = null;

    private disposed = false;
    private queue!: PQueue;
    private windowManager!: IWindowManager;
    private appConfig!: IAppConfigReader;
    private db!: IDatabaseProvider;
    private pluginManager!: IPluginManagerForDownload;
    private mediaMeta!: IMediaMetaProvider;
    private downloadedSheet!: IDownloadedSheetProvider;
    private musicItemProvider!: IMusicItemProvider;
    /** 文件真值查询 / 登记（localMusic 注入；缺失时退回下载记录，便于模块独立运行） */
    private localFileLookup?: ILocalFileLookupFn;
    private localFileRegister?: (params: {
        filePath: string;
        platform: string;
        id: string;
        title?: string;
        artist?: string;
        quality?: IMusic.IQualityKey | null;
    }) => void;

    /** 活跃的下载任务（仅 downloading 状态） */
    private activeTasks = new Map<string, DownloadTask>();
    /** 任务世代号（每次 pause/remove 递增，用于拦截过时的 p-queue 回调） */
    private taskGeneration = new Map<string, number>();
    /** 下载进度缓存（用于节流广播） */
    private progressCache = new Map<string, IDownloadProgress>();
    /** 预编译 SQL */
    private queries!: IQueries;
    /** 下载完成时的原子事务 */
    private completeTransaction!: IDbTransaction<
        (task: IDownloadTask, musicItem: IMusic.IMusicItem | null) => void
    >;

    /** 节流广播进度（200ms） */
    private broadcastProgress: IThrottledFunction<() => void> = throttle(() => {
        if (this.disposed) return;
        const tasks = Array.from(this.progressCache.values());
        if (tasks.length > 0) {
            this.windowManager.broadcast(IPC.PROGRESS, { tasks });
            this.progressCache.clear();
        }
    }, 200);

    /**
     * 注册「文件已下载完成」回调。
     *
     * 由 main 在 localMusic 初始化之后注入：下载完成 → 触发一次本地音乐重扫，
     * 否则新文件要等下次启动的静默重扫才会进「本地音乐」列表。
     */
    public setFileDownloadedHook(hook: (() => void) | null): void {
        this.onFileDownloaded = hook;
    }

    /**
     * 注册「本地文件已删除」回调。
     *
     * 由 main 在 localMusic 初始化之后注入：删除下载文件用的是 `fsp.unlink`，
     * 不触发目录扫描，不通知本地音乐库的话，「本地音乐」里会留下一条
     * 指向已删文件的记录（列表里还在、双击放不出来）。
     */
    public setFileDeletedHook(hook: ((filePath: string) => void) | null): void {
        this.onFileDeleted = hook;
    }

    public setup(deps: {
        db: IDatabaseProvider;
        appConfig: IAppConfigReader;
        windowManager: IWindowManager;
        pluginManager: IPluginManagerForDownload;
        mediaMeta: IMediaMetaProvider;
        downloadedSheet: IDownloadedSheetProvider;
        musicItemProvider: IMusicItemProvider;
        /** 文件真值查询（localMusic.lookupFile）：判断「本地有没有文件」不再看下载记录 */
        localFileLookup?: ILocalFileLookupFn;
        /** 下载完成后把文件登记进文件真值层（localMusic.registerDownloadedFile） */
        localFileRegister?: (params: {
            filePath: string;
            platform: string;
            id: string;
            title?: string;
            artist?: string;
            quality?: IMusic.IQualityKey | null;
        }) => void;
    }): void {
        if (this.isSetup) return;

        this.db = deps.db;
        this.appConfig = deps.appConfig;
        this.windowManager = deps.windowManager;
        this.pluginManager = deps.pluginManager;
        this.mediaMeta = deps.mediaMeta;
        this.downloadedSheet = deps.downloadedSheet;
        this.musicItemProvider = deps.musicItemProvider;
        this.localFileLookup = deps.localFileLookup;
        this.localFileRegister = deps.localFileRegister;

        // 初始化预编译 SQL
        this.initQueries();

        // 初始化并发队列
        const concurrency = this.appConfig.getConfigByKey('download.concurrency') ?? 5;
        this.queue = new PQueue({ concurrency });

        // 监听配置变更，动态调整并发数
        this.appConfig.onConfigUpdated((patch) => {
            if (
                'download.concurrency' in patch &&
                typeof patch['download.concurrency'] === 'number'
            ) {
                this.queue.concurrency = patch['download.concurrency'];
            }
        });

        // 注册 IPC handlers
        this.registerIpcHandlers();

        // 启动时恢复未完成的任务为 paused 状态
        this.recoverTasks();

        this.isSetup = true;
    }

    public dispose(): void {
        this.disposed = true;
        this.broadcastProgress.cancel();

        // 暂停所有活跃任务
        for (const [, dt] of this.activeTasks) {
            dt.abort();
            dt.task.status = 'paused';
            dt.task.updatedAt = Date.now();
            this.updateTaskStatus(dt.task);
        }
        this.activeTasks.clear();
        this.queue.clear();
    }

    // ─── 初始化 ────────────────────────

    private initQueries(): void {
        const db = this.db.getDatabase();

        this.queries = {
            insertTask: db.prepare(`
                INSERT INTO download_tasks
                    (id, platform, music_id, title, artist, album, quality,
                     status, file_path, temp_path, total_bytes, downloaded_bytes,
                     media_source, music_item_raw, error, created_at, updated_at)
                VALUES
                    (@id, @platform, @musicId, @title, @artist, @album, @quality,
                     @status, @filePath, @tempPath, @totalBytes, @downloadedBytes,
                     @mediaSource, @musicItemRaw, @error, @createdAt, @updatedAt)
            `),

            updateStatus: db.prepare(`
                UPDATE download_tasks SET
                    status = @status,
                    quality = @quality,
                    file_path = @filePath,
                    total_bytes = @totalBytes,
                    downloaded_bytes = @downloadedBytes,
                    media_source = @mediaSource,
                    error = @error,
                    updated_at = @updatedAt
                WHERE id = @id
            `),

            getTaskById: db.prepare('SELECT * FROM download_tasks WHERE id = ?'),

            /** 按歌曲身份取当前任务（列表上的失败图标要清除对应任务的失败态） */
            getTaskByMusic: db.prepare(
                'SELECT * FROM download_tasks WHERE platform = ? AND music_id = ? ORDER BY created_at DESC LIMIT 1',
            ),

            getTasksPaginated: db.prepare(
                'SELECT * FROM download_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?',
            ),

            getAllTasksUnpaginated: db.prepare(
                'SELECT * FROM download_tasks ORDER BY created_at DESC',
            ),

            getTaskCount: db.prepare('SELECT COUNT(*) AS count FROM download_tasks'),

            deleteTask: db.prepare('DELETE FROM download_tasks WHERE id = ?'),

            findExistingActive: db.prepare(
                `SELECT * FROM download_tasks
                 WHERE platform = ? AND music_id = ?
                   AND status IN ('pending', 'downloading', 'paused', 'error')
                 LIMIT 1`,
            ),

            recoverTasks: db.prepare(
                `UPDATE download_tasks SET status = 'paused', updated_at = ?
                 WHERE status IN ('downloading', 'pending')`,
            ),

            getPausedTasks: db.prepare(
                `SELECT * FROM download_tasks WHERE status = 'paused' ORDER BY created_at ASC`,
            ),

            getPendingTaskIds: db.prepare(`SELECT id FROM download_tasks WHERE status = 'pending'`),
        };

        // H1: 原子事务封装下载完成的多步操作
        this.completeTransaction = db.transaction(
            (task: IDownloadTask, musicItem: IMusic.IMusicItem | null) => {
                // 1. 写入 music_items + __downloaded__ 歌单
                if (musicItem) {
                    this.downloadedSheet.addMusicToDownloaded(musicItem);
                }

                // 2. 写入 mediaMeta（下载路径 + 音质）
                //    作品键跟着写：换个插件播同一首歌也要能认到这份本地文件
                this.mediaMeta.setMeta(
                    task.platform,
                    task.musicId,
                    {
                        downloadData: {
                            path: task.filePath!,
                            quality: task.quality,
                            // 记录时间：下载管理列表按它倒序排（不用 meta.updated_at，
                            // 那个被任何 meta 写入都会刷新）
                            at: Date.now(),
                        },
                    },
                    { title: task.title, artist: task.artist },
                );

                // 3. 从 download_tasks 删除已完成行（C1: 不保留完成记录）
                this.queries.deleteTask.run(task.id);

                // 4. 把文件登记进**文件真值层**（本地音乐库）
                //    下载目录不一定在扫描范围内；登记后这份文件就是「本地有」，
                //    取源/歌词/传云端按文件真值命中，删掉下载记录也不影响。
                try {
                    this.localFileRegister?.({
                        filePath: task.filePath!,
                        platform: task.platform,
                        id: String(task.musicId),
                        title: task.title,
                        artist: task.artist,
                        quality: task.quality,
                    });
                } catch (err) {
                    console.warn('[DownloadManager] 登记本地文件失败:', err);
                }
            },
        );
    }

    private registerIpcHandlers(): void {
        ipcMain.handle(IPC.ADD_TASK, async (_evt, params: IAddDownloadParams) => {
            return this.addTask(params.musicItem, params.quality);
        });

        ipcMain.handle(
            IPC.ADD_TASKS_BATCH,
            async (
                _evt,
                params: {
                    musicItems: Array<IMusic.IMusicItem | IMusicItemSlim>;
                    quality?: IMusic.IQualityKey;
                },
            ) => {
                return this.addTasksBatch(params.musicItems, params.quality);
            },
        );

        ipcMain.handle(IPC.PAUSE_TASK, (_evt, taskId: string) => {
            this.pauseTask(taskId);
        });

        ipcMain.handle(IPC.RESUME_TASK, (_evt, taskId: string) => {
            this.resumeTask(taskId);
        });

        ipcMain.handle(IPC.REMOVE_TASK, async (_evt, taskId: string) => {
            await this.removeTask(taskId);
        });

        ipcMain.handle(
            IPC.REMOVE_DOWNLOAD,
            async (_evt, platform: string, musicId: string, deleteFile?: boolean) => {
                await this.removeDownload(platform, musicId, deleteFile);
            },
        );

        ipcMain.handle(IPC.RETRY_TASK, (_evt, taskId: string) => {
            this.retryTask(taskId);
        });

        ipcMain.handle(IPC.CLEAR_TASK_ERROR, (_evt, taskId: string) => {
            this.clearTaskError(taskId);
        });

        ipcMain.handle(IPC.PAUSE_ALL, () => {
            this.pauseAll();
        });

        ipcMain.handle(IPC.RESUME_ALL, () => {
            this.resumeAll();
        });

        ipcMain.handle(IPC.GET_TASKS, (_evt, page: number, pageSize: number) => {
            return this.getTasks(page, pageSize);
        });

        ipcMain.handle(IPC.GET_ALL_TASKS, () => {
            return this.getAllTasks();
        });

        ipcMain.handle(IPC.GET_ALL_DOWNLOADED, () => {
            return this.mediaMeta.getAllDownloaded();
        });
    }

    // ─── 核心方法 ────────────────────────

    private async addTask(
        musicItem: IMusic.IMusicItem | IMusicItemSlim,
        quality: IMusic.IQualityKey | undefined,
    ): Promise<IDownloadTask> {
        const targetQuality =
            quality ?? this.appConfig.getConfigByKey('download.defaultQuality') ?? 'standard';
        const downloadPath =
            this.appConfig.getConfigByKey('download.path') ??
            globalContext.appPath.defaultDownloadPath;

        const platform = musicItem.platform;
        const musicId = String(musicItem.id);

        // M1: 先检查是否存在活跃（pending/downloading/paused/error）的任务
        const existingActive = this.queries.findExistingActive.get(platform, musicId) as
            | IDownloadTaskRow
            | undefined;
        if (existingActive) return rowToTask(existingActive);

        // C1: 再检查是否「本地已经有这份文件」——按**文件真值**判断（本地音乐库 ∪ 下载记录路径），
        //     不再只认下载记录：记录被移除但文件还在时，重复下载只会把同一份文件再写一遍。
        const existingLocal = await this.lookupLocalFile({
            platform,
            id: musicId,
            title: musicItem.title,
            artist: musicItem.artist,
            originPlatform: musicItem.originPlatform,
            originId: musicItem.originId,
        });
        if (existingLocal?.path) {
            throw new Error(i18n.t('download.already_downloaded'));
        }
        // 记录还在但文件没了 → 清掉幽灵记录（否则列表里一直挂着「已下载」）
        const existingDownload = this.mediaMeta.getDownloadData(platform, musicId);
        if (existingDownload && !(await this.fileExists(existingDownload.path))) {
            this.clearStaleDownloadRecord(existingDownload.path);
        }

        const fileName = this.buildFileName(musicItem);
        const filePath = path.join(downloadPath, fileName);

        const now = Date.now();
        const id = nanoid();
        const tempPath = `${filePath}.${id}.downloading`;

        const task: IDownloadTask = {
            id,
            platform,
            musicId,
            title: musicItem.title,
            artist: musicItem.artist ?? '',
            album: musicItem.album ?? '',
            quality: targetQuality,
            status: 'pending',
            filePath,
            tempPath,
            totalBytes: 0,
            downloadedBytes: 0,
            mediaSource: null,
            musicItemRaw: safeStringify(musicItem),
            error: null,
            createdAt: now,
            updatedAt: now,
        };

        // 1. 持久化下载任务到 SQLite（musicItem 序列化为 musicItemRaw 列）
        if (!this.persistTask(task)) {
            // UNIQUE 冲突 → 同一首歌已在任务表中，返回已有记录
            const existing = this.queries.findExistingActive.get(platform, musicId) as
                | IDownloadTaskRow
                | undefined;
            if (existing) return rowToTask(existing);
            throw new Error(i18n.t('download.already_in_queue'));
        }

        // 2. 入队
        this.enqueueTask(task);

        // 通知渲染进程
        this.windowManager.broadcast(IPC.TASK_EVENT, { task, type: 'added' });

        return task;
    }

    /**
     * 文件是否真的存在（「已下载」判定用）。
     *
     * 不能只看 media_meta 里的下载记录：记录是「下载过」这件事的痕迹，
     * 不是「文件还在」的事实，用户手动删掉文件后两者就分叉了。
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            const stat = await fsp.stat(filePath);
            return stat.isFile();
        } catch {
            return false;
        }
    }

    /**
     * 清掉指向「已不存在的文件」的下载记录。
     *
     * 记录可能挂在另一个插件身份下（读取时按作品键合并过来的），
     * 所以按路径反查真正的哪一行，而不是直接删 (platform, musicId) 这条。
     */
    private clearStaleDownloadRecord(filePath: string): void {
        try {
            const owner = this.mediaMeta.getMetaByDownloadPath(filePath);
            if (!owner) return;
            this.mediaMeta.setMeta(owner.platform, owner.musicId, { downloadData: null });
            console.warn(
                `[DownloadManager] 清理失效下载记录 ${owner.platform}@${owner.musicId}: ${filePath}`,
            );
        } catch (err) {
            console.warn('[DownloadManager] 清理失效下载记录失败:', err);
        }
    }

    /**
     * 「这首歌本地有没有文件」——**文件真值**查询。
     *
     * 优先走注入的 `localMusic.lookupFile`（本地音乐库 ∪ 记录路径，且校验文件存在）；
     * 没注入时退回下载记录路径（模块可独立运行 / 老调用方）。
     * 传了 `originPlatform` 的条目（「切到本地/云盘」）会连原始身份一起查。
     *
     * @returns 命中时的路径与登记音质；本地没有文件返回 null
     */
    private async lookupLocalFile(item: {
        platform: string;
        id: string;
        originPlatform?: string;
        originId?: string;
        title?: string;
        artist?: string;
    }): Promise<{ path: string; quality: IMusic.IQualityKey | null } | null> {
        if (this.localFileLookup) {
            try {
                const hit = await this.localFileLookup({
                    platform: item.platform,
                    id: String(item.id),
                    originPlatform: item.originPlatform,
                    originId: item.originId,
                    title: item.title,
                    artist: item.artist,
                });
                if (hit?.path) return hit;
            } catch (err) {
                console.warn('[DownloadManager] 文件真值查询失败，回退下载记录:', err);
            }
        }

        const record = this.mediaMeta.getDownloadData(item.platform, String(item.id));
        if (record?.path && (await this.fileExists(record.path))) {
            return { path: record.path, quality: record.quality ?? null };
        }
        return null;
    }

    /**
     * M7: 批量添加下载任务，使用 Promise.allSettled 并发获取媒体源。
     */
    private async addTasksBatch(
        musicItems: Array<IMusic.IMusicItem | IMusicItemSlim>,
        quality?: IMusic.IQualityKey,
    ): Promise<IDownloadTask[]> {
        const results = await Promise.allSettled(
            musicItems.map((item) => this.addTask(item, quality)),
        );
        return results
            .filter((r): r is PromiseFulfilledResult<IDownloadTask> => r.status === 'fulfilled')
            .map((r) => r.value);
    }

    private enqueueTask(task: IDownloadTask): void {
        // 捕获当前世代号，回调执行时比对——若不一致说明中间发生过 pause/remove
        const generation = this.taskGeneration.get(task.id) ?? 0;

        this.queue.add(async () => {
            // 世代号不匹配 → 入队后发生过 pause/remove，跳过执行
            if ((this.taskGeneration.get(task.id) ?? 0) !== generation) return;

            // DB 新鲜度校验：防止快速 pause-resume 导致重复执行
            const freshRow = this.queries.getTaskById.get(task.id) as IDownloadTaskRow | undefined;
            if (!freshRow || freshRow.status !== 'pending') return;

            // 延迟获取媒体源：在任务真正开始执行时才获取，避免 resumeAll 过早批量请求
            let musicItem = safeParse<IMusic.IMusicItem>(task.musicItemRaw ?? '');
            if (musicItem && !task.mediaSource) {
                // slim 对象解析：插件 getMediaSource 可能依赖完整字段，从 DB 查询 raw JSON
                if ((musicItem as any)[INTERNAL_SLIM_KEY]) {
                    const full = this.musicItemProvider.getRawMusicItem(
                        musicItem.platform,
                        String(musicItem.id),
                    );
                    if (full) {
                        musicItem = full;
                        task.musicItemRaw = safeStringify(full);
                    }
                }

                try {
                    const source = await this.pluginManager.getMediaSource(
                        musicItem,
                        task.quality,
                        QUALITY_KEYS,
                        this.appConfig.getConfigByKey('download.whenQualityMissing') ?? 'lower',
                    );

                    if (source?.url) {
                        task.mediaSource = safeStringify(source);
                        // 更新实际音质（插件可能回退到其他音质）
                        if (source.quality && source.quality !== task.quality) {
                            task.quality = source.quality;
                        }
                    }
                } catch {
                    // 获取失败 → mediaSource 仍为 null，走下方兜底
                }
            }

            // 再次检查世代号（异步 getMediaSource 期间可能被 pause/remove）
            if ((this.taskGeneration.get(task.id) ?? 0) !== generation) return;

            // 检查是否在异步间隙中被 dispose
            if (this.disposed) return;

            // mediaSource 仍为空 → 无法下载，直接标记错误
            if (!task.mediaSource) {
                task.status = 'error';
                task.error = i18n.t('download.cannot_get_source');
                task.updatedAt = Date.now();
                this.updateTaskStatus(task);
                this.windowManager.broadcast(IPC.TASK_EVENT, { task, type: 'error' });
                return;
            }

            task.status = 'downloading';
            this.updateTaskStatus(task);
            this.windowManager.broadcast(IPC.TASK_EVENT, {
                task,
                type: 'status-changed',
            });

            const dt = new DownloadTask(task);
            this.activeTasks.set(task.id, dt);

            // 保存原始 filePath（不含扩展名），以便 completeTransaction 失败时恢复
            const baseFilePath = task.filePath;

            await dt.execute(
                // onProgress
                (downloadedBytes, totalBytes, speed) => {
                    this.progressCache.set(task.id, {
                        id: task.id,
                        downloadedBytes,
                        totalBytes,
                        speed,
                    });
                    this.broadcastProgress();
                },
                // onCompleted
                () => {
                    this.activeTasks.delete(task.id);
                    this.progressCache.delete(task.id);

                    // 任务可能在 rename 间隙被 removeTask 删除
                    const freshRow = this.queries.getTaskById.get(task.id);
                    if (!freshRow) return;

                    try {
                        task.status = 'completed';
                        task.updatedAt = Date.now();

                        // H1: 原子事务 — 写入歌单 + mediaMeta + 删除任务行
                        const musicItem = safeParse<IMusic.IMusicItem>(task.musicItemRaw ?? '');
                        this.completeTransaction(task, musicItem);

                        // 歌词落盘：同名 .lrc（放在歌曲目录或 download.lyricPath）
                        // best-effort，失败只打日志，不影响「下载成功」。
                        // 落盘之后再通知外部重扫：否则重扫会跑在 .lrc 写入之前，
                        // 新歌词要等下一次扫描才会进「本地歌词文件」列表。
                        void this.writeLyricFile(task, musicItem).finally(() => {
                            try {
                                this.onFileDownloaded?.();
                            } catch {
                                /* 钩子异常不影响下载结果 */
                            }
                        });

                        this.windowManager.broadcast(IPC.TASK_EVENT, {
                            task,
                            type: 'completed',
                        });
                    } catch (completeErr: any) {
                        // 清理已 rename 的孤立文件，避免磁盘泄漏
                        if (task.filePath) {
                            fsp.unlink(task.filePath).catch(() => {
                                /* ignore */
                            });
                        }
                        // 恢复原始无扩展名路径，避免 retry 时产生双重扩展名
                        task.filePath = baseFilePath;
                        task.status = 'error';
                        task.error = i18n.t('download.complete_failed', {
                            reason: completeErr.message,
                        });
                        task.updatedAt = Date.now();
                        try {
                            this.updateTaskStatus(task);
                        } catch {
                            // DB 不可恢复，仅广播状态
                        }
                        this.windowManager.broadcast(IPC.TASK_EVENT, {
                            task,
                            type: 'error',
                        });
                    }
                },
                // onError
                (err) => {
                    if (dt.isAborted) return;

                    task.status = 'error';
                    task.error = err.message;
                    task.updatedAt = Date.now();
                    this.activeTasks.delete(task.id);
                    this.progressCache.delete(task.id);
                    this.updateTaskStatus(task);
                    this.windowManager.broadcast(IPC.TASK_EVENT, {
                        task,
                        type: 'error',
                    });
                },
            );
        });
    }

    private pauseTask(taskId: string): void {
        // 检查活跃任务
        const active = this.activeTasks.get(taskId);
        if (active) {
            active.abort();
            active.task.status = 'paused';
            active.task.updatedAt = Date.now();
            this.updateTaskStatus(active.task);
            this.activeTasks.delete(taskId);
            this.windowManager.broadcast(IPC.TASK_EVENT, {
                task: active.task,
                type: 'status-changed',
            });
            return;
        }

        // pending 状态也标记为 paused，递增世代号使对应的 p-queue 回调失效
        const row = this.queries.getTaskById.get(taskId) as IDownloadTaskRow | undefined;
        if (row && row.status === 'pending') {
            this.taskGeneration.set(taskId, (this.taskGeneration.get(taskId) ?? 0) + 1);
            const task = rowToTask(row);
            task.status = 'paused';
            task.updatedAt = Date.now();
            this.updateTaskStatus(task);
            this.windowManager.broadcast(IPC.TASK_EVENT, {
                task,
                type: 'status-changed',
            });
        }
    }

    /**
     * 恢复任务：mediaSource 延迟到 enqueueTask 回调中获取，避免 resumeAll 时密集请求。
     */
    private resumeTask(taskId: string): void {
        const row = this.queries.getTaskById.get(taskId) as IDownloadTaskRow | undefined;
        if (!row || row.status !== 'paused') return;

        const task = rowToTask(row);

        // 清空 mediaSource 强制延迟到 enqueueTask 中重新获取
        task.mediaSource = null;
        task.status = 'pending';
        task.error = null;
        task.updatedAt = Date.now();
        this.updateTaskStatus(task);
        this.enqueueTask(task);
        this.windowManager.broadcast(IPC.TASK_EVENT, { task, type: 'status-changed' });
    }

    private retryTask(taskId: string): void {
        const row = this.queries.getTaskById.get(taskId) as IDownloadTaskRow | undefined;
        if (!row || row.status !== 'error') return;

        const task = rowToTask(row);

        // 删除旧临时文件，确保干净重试（新 URL 可能来自不同 CDN）
        if (task.tempPath) {
            fsp.unlink(task.tempPath).catch(() => {
                /* ignore */
            });
        }

        // 清空 mediaSource 强制延迟到 enqueueTask 中重新获取
        task.mediaSource = null;
        task.status = 'pending';
        task.error = null;
        task.downloadedBytes = 0;
        task.totalBytes = 0;
        task.updatedAt = Date.now();
        this.updateTaskStatus(task);
        this.enqueueTask(task);
        this.windowManager.broadcast(IPC.TASK_EVENT, { task, type: 'status-changed' });
    }

    /**
     * 清除失败状态：把 error 任务重置为「已暂停」。
     *
     * 语义是「这次失败我知道了，别再红着」——**不会**自动重跑（那会立刻再失败一次），
     * 任务停在灰色「已暂停」，用户想再试时点列表上的下载图标 / 下载管理的继续按钮
     * （走 resumeTask，会重新取源）。临时文件保留，续传时能用上。
     */
    private clearTaskError(taskId: string): void {
        const row = this.queries.getTaskById.get(taskId) as IDownloadTaskRow | undefined;
        if (!row || row.status !== 'error') return;

        const task = rowToTask(row);
        task.status = 'paused';
        task.error = null;
        task.updatedAt = Date.now();
        this.updateTaskStatus(task);
        this.windowManager.broadcast(IPC.TASK_EVENT, { task, type: 'status-changed' });
    }

    /** 按歌曲身份清除失败状态（列表上的失败图标用） */
    private clearTaskErrorByMusic(platform: string, musicId: string): void {
        const row = this.queries.getTaskByMusic.get(platform, String(musicId)) as
            | IDownloadTaskRow
            | undefined;
        if (row) this.clearTaskError(row.id);
    }

    /**
     * 删除活跃下载任务（pending/downloading/paused/error）。
     * - 中止活跃下载 + 删除临时文件 + 从 DB 删除
     */
    private async removeTask(taskId: string): Promise<void> {
        // 先中止活跃下载
        const active = this.activeTasks.get(taskId);
        if (active) {
            active.abort();
            this.activeTasks.delete(taskId);
        }

        // 读取任务信息
        const row = this.queries.getTaskById.get(taskId) as IDownloadTaskRow | undefined;

        // 递增世代号使对应的 p-queue 回调失效
        this.taskGeneration.set(taskId, (this.taskGeneration.get(taskId) ?? 0) + 1);

        // 清理临时文件
        if (row?.temp_path) {
            try {
                await fsp.unlink(row.temp_path);
            } catch {
                // 文件不存在等情况忽略
            }
        }

        // 从 DB 删除任务记录
        this.queries.deleteTask.run(taskId);

        if (row) {
            this.windowManager.broadcast(IPC.TASK_EVENT, {
                task: rowToTask(row),
                type: 'removed',
            });
        }
    }

    /**
     * 删除已完成的下载（歌单 + mediaMeta，可选删除本地文件）。
     * C1: 完成后 download_tasks 中已无记录，操作对象是 mediaMeta + musicSheet。
     * @param deleteFile 是否同时删除本地文件，默认 true
     */
    private async removeDownload(
        platform: string,
        musicId: string,
        deleteFile = true,
    ): Promise<void> {
        // 文件路径先按**文件真值**找（记录被移除后文件仍在的情况也要能删掉）；
        // 找得到才说明本地真有这份文件，找不到就只清记录。
        const local = await this.lookupLocalFile({ platform, id: String(musicId) });
        const downloadData = this.mediaMeta.getDownloadData(platform, musicId);
        const filePath = local?.path ?? downloadData?.path ?? null;

        // 删除本地文件（可选）
        if (deleteFile && filePath) {
            try {
                await fsp.unlink(filePath);
            } catch {
                // ignore
            }
            // 文件从磁盘上没了 → 让本地音乐库同步删掉这条记录
            this.onFileDeleted?.(filePath);
        }

        // 从 __downloaded__ 歌单移除 + 清除 mediaMeta（原子事务）
        const db = this.db.getDatabase();
        db.transaction(() => {
            this.downloadedSheet.removeFromDownloaded(platform, musicId);
            this.mediaMeta.setMeta(platform, musicId, {
                downloadData: null,
            });
        })();

        this.windowManager.broadcast(IPC.TASK_EVENT, {
            task: {
                id: '',
                platform,
                musicId,
                title: '',
                artist: '',
                album: '',
                quality: 'standard' as IMusic.IQualityKey,
                status: 'completed' as DownloadStatus,
                filePath,
                tempPath: null,
                totalBytes: 0,
                downloadedBytes: 0,
                mediaSource: null,
                musicItemRaw: null,
                error: null,
                createdAt: 0,
                updatedAt: 0,
            },
            type: 'removed',
        });
    }

    /** L5: 使用预编译语句查询 pending 任务 */
    private pauseAll(): void {
        // 快照 keys 再遍历，因为 pauseTask 内部会修改 activeTasks
        for (const taskId of Array.from(this.activeTasks.keys())) {
            this.pauseTask(taskId);
        }
        // 暂停队列中等待的 pending 任务
        const pendingRows = this.queries.getPendingTaskIds.all() as Array<{ id: string }>;
        for (const { id } of pendingRows) {
            this.pauseTask(id);
        }
    }

    private resumeAll(): void {
        const rows = this.queries.getPausedTasks.all() as IDownloadTaskRow[];
        for (const row of rows) {
            this.resumeTask(row.id);
        }
    }

    private getTasks(page: number, pageSize: number): { data: IDownloadTask[]; total: number } {
        const offset = (page - 1) * pageSize;
        const rows = this.queries.getTasksPaginated.all(pageSize, offset) as IDownloadTaskRow[];
        const { count } = this.queries.getTaskCount.get() as { count: number };
        return {
            data: rows.map(rowToTask),
            total: count,
        };
    }

    private getAllTasks(): IDownloadTask[] {
        const rows = this.queries.getAllTasksUnpaginated.all() as IDownloadTaskRow[];
        return rows.map(rowToTask);
    }

    // ─── 辅助 ────────────────────────

    /**
     * 持久化任务到 DB。返回 true 表示成功插入，false 表示 UNIQUE 冲突（重复歌曲）。
     */
    private persistTask(task: IDownloadTask): boolean {
        try {
            this.queries.insertTask.run({
                id: task.id,
                platform: task.platform,
                musicId: task.musicId,
                title: task.title,
                artist: task.artist,
                album: task.album,
                quality: task.quality,
                status: task.status,
                filePath: task.filePath,
                tempPath: task.tempPath,
                totalBytes: task.totalBytes,
                downloadedBytes: task.downloadedBytes,
                mediaSource: task.mediaSource,
                musicItemRaw: task.musicItemRaw,
                error: task.error,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
            });
            return true;
        } catch (err: any) {
            // 唯一约束冲突 → 表示这首已经有一条任务了，按"已存在"处理
            //
            // 换到 node:sqlite 后错误形态变了：不再有 `code = 'SQLITE_CONSTRAINT_UNIQUE'`，
            // 而是 `code = 'ERR_SQLITE_ERROR'` + `errcode`（扩展错误码）+ `errstr`。
            //   2067 = SQLITE_CONSTRAINT_UNIQUE —— 命中 idx_download_tasks_unique_music(platform, music_id)
            //   1555 = SQLITE_CONSTRAINT_PRIMARYKEY —— 命中 id 主键
            if (err?.errcode === 2067 || err?.errcode === 1555) {
                return false;
            }
            throw err;
        }
    }

    private updateTaskStatus(task: IDownloadTask): void {
        this.queries.updateStatus.run({
            id: task.id,
            status: task.status,
            quality: task.quality,
            filePath: task.filePath,
            totalBytes: task.totalBytes,
            downloadedBytes: task.downloadedBytes,
            mediaSource: task.mediaSource,
            error: task.error,
            updatedAt: task.updatedAt,
        });
    }

    /**
     * 构建文件名（不含扩展名，由 downloadTask 下载完成后根据 Content-Type 推断）。
     *
     * 命名约定统一为 `<歌名> - <歌手>`（歌名在前），与云盘文件名、歌词文件名、
     * 托盘/缩略图提示保持同一顺序。
     */
    private buildFileName(musicItem: IMusic.IMusicItem): string {
        const artist = musicItem.artist || 'Unknown';
        const title = musicItem.title || 'Unknown';
        return sanitizeFileName(`${title} - ${artist}`, 170);
    }

    /**
     * 下载完成后把歌词写成和歌曲同名的 .lrc。
     *
     * 落地位置：
     *   - 配了下载设置里的「歌词下载路径」→ 放那里
     *   - 没配 → 与歌曲文件同目录同名（播放时「本地歌词文件」这一级直接命中）
     *
     * 文件名与歌曲主名一致（`<歌名> - <歌手>.lrc`），翻译歌词写成 `<歌名> - <歌手>-tr.lrc`。
     * 已存在同名 .lrc 时不覆盖——用户手写的歌词比插件拉来的更值得保留。
     */
    private async writeLyricFile(
        task: IDownloadTask,
        musicItem: IMusic.IMusicItem | null,
    ): Promise<void> {
        try {
            if (!musicItem || !task.filePath) return;

            const lyricSource = await this.pluginManager.getLyric(musicItem);
            const rawLrc = lyricSource?.rawLrc ?? lyricSource?.lrc;
            if (!rawLrc) return;

            const parsed = path.parse(task.filePath);
            const configuredDir = this.appConfig.getConfigByKey('download.lyricPath')?.trim();
            const lyricDir = configuredDir || parsed.dir;

            await fsp.mkdir(lyricDir, { recursive: true });

            const written = await this.writeLyricOnce(
                path.join(lyricDir, `${parsed.name}.lrc`),
                rawLrc,
            );
            if (lyricSource?.translation) {
                await this.writeLyricOnce(
                    path.join(lyricDir, `${parsed.name}-tr.lrc`),
                    lyricSource.translation,
                );
            }

            console.log('[download] lyric saved =', written, '| dir =', lyricDir);
        } catch (err) {
            console.warn('[download] 歌词落盘失败:', err);
        }
    }

    /** 写歌词文件；目标已存在时跳过（不覆盖用户已有的 .lrc） */
    private async writeLyricOnce(filePath: string, content: string): Promise<string | null> {
        try {
            await fsp.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
            return filePath;
        } catch (err: any) {
            if (err?.code === 'EEXIST') return null;
            throw err;
        }
    }

    /** 应用启动时，将所有 downloading/pending 状态恢复为 paused */
    private recoverTasks(): void {
        this.queries.recoverTasks.run(Date.now());
    }
}

const downloadManager = new DownloadManager();
export default downloadManager;
