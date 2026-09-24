/* eslint-disable @typescript-eslint/member-ordering -- 本文件 public/private 按功能就近排布，不按排序规则 */
/**
 * cloudDisk — 主进程层
 *
 * 职责：
 * - 复用「设置 → 备份」里的 WebDAV 配置（backup.webdav.*），把远端 /MusicFree/music 当音乐库
 * - PROPFIND 列出远端音频文件 → 转成 IMusicItem（platform = CLOUD_PLUGIN_NAME）
 * - 生成「可直接播放」的地址：WebDAV 需要 Basic Auth，而 <audio> 不能带认证头，
 *   因此走 RequestForwarder（本地回环代理）：它会把 Range 等请求头原样转发，
 *   并把目标的 206/响应头回传，所以拖动进度条、边下边播都能正常工作。
 *
 * 目录约定见 common/constant.ts
 */

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { ipcMain } from 'electron';
import type { IDbCompat, IDbStatement, IDatabaseProvider } from '@appTypes/infra/database';
import { createClient, AuthType, type WebDAVClient } from 'webdav';
import type { IAppConfigReader } from '@appTypes/infra/appConfig';
import type { IMediaMetaProvider } from '@appTypes/infra/mediaMeta';
import type {
    IDownloadedSheetProvider,
    IPluginManagerForDownload,
} from '@appTypes/infra/downloadManager';
import type { IMusicItemProvider } from '@appTypes/infra/musicSheet';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type {
    ICloudDownloadResult,
    ICloudDownloadTask,
    ICloudDownloadOptions,
    ICloudFile,
    ICloudLyricFile,
    ICloudStatus,
    ICloudUploadIdentity,
    ICloudUploadProgress,
    ICloudUploadRecord,
    ICloudUploadResult,
    ICloudUploadSource,
    ICloudUploadTask,
} from '@appTypes/infra/cloudDisk';
import { CLOUD_PLUGIN_NAME, QUALITY_KEYS, SUPPORTED_AUDIO_EXTS } from '@common/constant';
import i18n from '@infra/i18n/main';
import requestForwarder from '@infra/requestForwarder/main';
import {
    CLOUD_LYRIC_DIR,
    CLOUD_MUSIC_DIR,
    CLOUD_TRASH_DIR,
    IPC,
    LIST_CACHE_TTL_MS,
    UPLOAD_CONCURRENCY,
} from '../common/constant';
import { buildMediaNameKey, normalizeTitleKey } from '@common/mediaNameKey';
import { selectOrphanUploads } from '../common/syncPlan';
import {
    davExtraHeaders,
    toLogicalName,
    toLogicalPath,
    toStoredName,
    toStoredPath,
} from './zoteroDavCompat';
import { openSourceStream } from './sourceStream';

interface IWebdavConfig {
    url: string;
    username: string;
    password: string;
}

/**
 * 已解析的文件名 → 歌名 / 歌手。
 *
 * 命名约定：`<歌名> - <歌手>`（歌名在前）。歌名本身可能含 ` - `
 * （例如 `珊瑚海 - R&B版 - 格雷乐团`），所以取**最后**一个 ` - ` 作分隔。
 */
function parseCloudFileName(fileName: string): { artist: string; title: string } {
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    const idx = base.lastIndexOf(' - ');
    if (idx <= 0) {
        return { artist: '', title: base.trim() };
    }
    return {
        title: base.slice(0, idx).trim(),
        artist: base.slice(idx + 3).trim(),
    };
}

/** 拼接 WebDAV 直链（逐段编码，兼容中文/空格/特殊字符） */
function joinRemoteUrl(baseUrl: string, remotePath: string): string {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const relative = remotePath
        .replace(/^\/+/, '')
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
    return new URL(relative, base).toString();
}

/**
 * 归一化「歌手|歌名」键。
 *
 * 直接交给 mediaNameKey：同一首歌各插件的歌手写法不一样
 * （`周杰伦&Lara梁心颐` / `周杰伦, Lara梁心颐` / `周杰伦、Lara梁心颐`），
 * 只按原始字符串比会认不出云盘上的同名文件。
 */
function normalizeKey(artist: string, title: string): string {
    return buildMediaNameKey(title, artist);
}

/** WebDAV 404（目录还不存在） */ function isNotFoundError(err: unknown): boolean {
    const status =
        (err as { status?: number; response?: { status?: number } })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
    return status === 404;
}

/** 清洗文件名：去掉 WebDAV/Windows 非法字符，限制长度 */
function sanitizeFileName(name: string, maxLength = 150): string {
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .trim();
    const result = cleaned || '未命名';
    return result.length > maxLength ? result.slice(0, maxLength).trim() : result;
}

// ─── Prepared Statements ───

interface ICloudDiskQueries {
    upsertUpload: IDbStatement;
    getManualUploads: IDbStatement;
    getAllUploads: IDbStatement;
    deleteByRemotePath: IDbStatement;
    deleteByIdentity: IDbStatement;
    deleteByIdentityPath: IDbStatement;
}

function createQueries(db: IDbCompat): ICloudDiskQueries {
    return {
        /**
         * 记录上传清单。
         * source 只升不降：自动上传过的条目被手动上传后记为 manual（反之不覆盖）。
         */
        upsertUpload: db.prepare(`
            INSERT INTO cloud_uploads
                (platform, music_id, title, artist, remote_path, local_path, source, size, uploaded_at, work_key)
            VALUES
                (@platform, @musicId, @title, @artist, @remotePath, @localPath, @source, @size, @uploadedAt, @workKey)
            ON CONFLICT(platform, music_id, remote_path) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                local_path = excluded.local_path,
                source = CASE WHEN cloud_uploads.source = 'manual' THEN 'manual' ELSE excluded.source END,
                size = excluded.size,
                uploaded_at = excluded.uploaded_at,
                work_key = COALESCE(excluded.work_key, cloud_uploads.work_key)
        `),
        getManualUploads: db.prepare(`
            SELECT platform, music_id AS musicId, title, artist, remote_path AS remotePath,
                   local_path AS localPath, source, size, uploaded_at AS uploadedAt,
                   work_key AS workKey
            FROM cloud_uploads
            WHERE source = 'manual'
            ORDER BY uploaded_at DESC
        `),
        getAllUploads: db.prepare(`
            SELECT platform, music_id AS musicId, title, artist, remote_path AS remotePath,
                   local_path AS localPath, source, size, uploaded_at AS uploadedAt,
                   work_key AS workKey
            FROM cloud_uploads
            ORDER BY uploaded_at DESC
        `),
        deleteByRemotePath: db.prepare('DELETE FROM cloud_uploads WHERE remote_path = ?'),
        deleteByIdentity: db.prepare(
            'DELETE FROM cloud_uploads WHERE platform = ? AND music_id = ?',
        ),
        /**
         * 删单条清单记录（清单主键是三元组）。
         *
         * 远端文件名是「歌名」的纯函数，同一首歌换个插件再传会命中同一个远端文件、
         * 却写出两条记录 —— 所以「移除记录」必须按三元组删，否则会连带删掉另一条身份。
         */
        deleteByIdentityPath: db.prepare(
            'DELETE FROM cloud_uploads WHERE platform = ? AND music_id = ? AND remote_path = ?',
        ),
    };
}

class CloudDiskManager {
    private isSetup = false;
    private appConfig!: IAppConfigReader;
    private mediaMeta!: IMediaMetaProvider;
    private downloadedSheet!: IDownloadedSheetProvider;
    private musicItemProvider!: IMusicItemProvider;
    /** 下载完成后把文件登记进文件真值层（localMusic.registerDownloadedFile） */
    private localFileRegister?: (params: {
        filePath: string;
        platform: string;
        id: string;
        title?: string;
        artist?: string;
        quality?: IMusic.IQualityKey | null;
    }) => void;
    /** 取源用（「本地没有文件也能传云端」：主进程自己向插件取音源） */
    private pluginManager: IPluginManagerForDownload | null = null;
    private windowManager: IWindowManager | null = null;
    private queries!: ICloudDiskQueries;

    /** 最近一次请求是否成功 */
    private connected: boolean | null = null;
    /** 最近一次错误 */
    private lastError: string | undefined;
    /** 列表缓存 */
    private cachedItems: IMusic.IMusicItem[] | null = null;
    /** 列表缓存时间（超过 TTL 自动重新拉取，保证网盘侧手动改动能被看到） */
    private cachedAt = 0;
    /** 歌名/歌手 → 远端路径（取源优先级用） */
    private cachedByName = new Map<string, string>();
    private cachedByTitle = new Map<string, string[]>();

    public setup(opts: {
        appConfig: IAppConfigReader;
        db: IDatabaseProvider;
        mediaMeta: IMediaMetaProvider;
        downloadedSheet: IDownloadedSheetProvider;
        musicItemProvider: IMusicItemProvider;
        /** 「本地没有文件也能传云端」要主进程自己取源 */
        pluginManager?: IPluginManagerForDownload;
        windowManager?: IWindowManager;
        /** 云端文件下载到本地后登记进文件真值层（localMusic.registerDownloadedFile） */
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

        this.appConfig = opts.appConfig;
        this.mediaMeta = opts.mediaMeta;
        this.downloadedSheet = opts.downloadedSheet;
        this.musicItemProvider = opts.musicItemProvider;
        this.localFileRegister = opts.localFileRegister;
        this.pluginManager = opts.pluginManager ?? null;
        this.windowManager = opts.windowManager ?? null;
        this.queries = createQueries(opts.db.getDatabase());

        ipcMain.handle(IPC.GET_ITEMS, (_evt, force?: boolean) => this.getMusicItems(force));
        ipcMain.handle(IPC.GET_STATUS, () => this.getStatus());
        ipcMain.handle(IPC.GET_LYRIC_TEXT, (_evt, name: string) => this.getLyricText(name));
        ipcMain.handle(IPC.PUT_LYRIC_TEXT, (_evt, name: string, text: string) =>
            this.putLyricText(name, text),
        );
        ipcMain.handle(IPC.LIST_LYRIC_FILES, () => this.listLyricFiles());
        ipcMain.handle(IPC.TEST_CONNECTION, () => this.testConnection());
        ipcMain.handle(IPC.UPLOAD_TASKS, (_evt, tasks: ICloudUploadTask[], source?: string) =>
            this.uploadTasks(tasks ?? [], source === 'manual' ? 'manual' : 'auto'),
        );
        ipcMain.handle(IPC.RESOLVE_SOURCE, (_evt, item: { title?: string; artist?: string }) =>
            this.findStreamUrl(item),
        );
        ipcMain.handle(IPC.GET_MANUAL_UPLOADS, () => this.getManualUploads());
        ipcMain.handle(IPC.GET_ALL_UPLOADS, () => this.getAllUploads());
        ipcMain.handle(IPC.DELETE_UPLOAD_RECORDS, (_evt, records: ICloudUploadIdentity[]) =>
            this.deleteUploadRecords(records ?? []),
        );
        ipcMain.handle(IPC.MOVE_TO_TRASH, (_evt, remotePaths: string[]) =>
            this.moveToTrash(remotePaths ?? []),
        );
        ipcMain.handle(
            IPC.TRASH_MISSING,
            (_evt, managedKeys: string[], managedWorkKeys?: string[]) =>
                this.trashUnmanagedMissingFiles(managedKeys ?? [], managedWorkKeys ?? []),
        );
        ipcMain.handle(
            IPC.DOWNLOAD_TO_LOCAL,
            (_evt, tasks: ICloudDownloadTask[], options?: ICloudDownloadOptions) =>
                this.downloadToLocal(tasks ?? [], options),
        );

        this.isSetup = true;
    }

    /**
     * 把「本地已经不存在的歌」对应的远端文件移入回收站。     *
     * 保守判定（见 common/syncPlan.ts）：
     * - 这首歌仍由本地管理（可能换了路径 / 换了插件）→ 保留
     * - 清单记录的本地路径仍存在 → 保留
     * - 两者都不成立（本地彻底删掉了）→ 移入回收站
     *
     * @param managedKeys 当前本地仍在管理的歌曲 key 列表（platform\0id）
     * @param managedWorkKeys 当前本地仍在管理的「作品键」列表（归一化 歌名|歌手）——
     *   同一首歌换了插件/来源之后 (platform,id) 会变，只按它判断会把好好的云备份误删
     */
    public async trashUnmanagedMissingFiles(
        managedKeys: string[],
        managedWorkKeys: string[] = [],
    ): Promise<number> {
        const rows = this.getAllUploads();
        if (!rows.length) return 0;

        // 主进程侧做文件存在性检查（一次 stat，避免渲染层逐条 IPC）
        const existingPaths = new Set<string>();
        for (const row of rows) {
            if (!row.localPath) continue;
            try {
                await fsp.stat(row.localPath);
                existingPaths.add(row.localPath);
            } catch {
                // 文件不存在
            }
        }

        const orphans = selectOrphanUploads(
            rows,
            new Set(managedKeys),
            existingPaths,
            new Set(managedWorkKeys.filter(Boolean)),
        );
        if (!orphans.length) return 0;
        return this.moveToTrash(orphans);
    }

    /**
     * 把云盘文件下载到本地（「按单曲恢复」= 把歌取回本地，不涉及歌单）。
     *
     * - 存到「设置 → 下载」的下载目录，文件名沿用 歌名 - 歌手.ext
     * - 同时写入 mediaMeta 下载记录（key 为原歌曲的 platform + id），
     *   这样播放这首歌时「本地优先」会直接命中本地文件
     * - 本地已存在同名同大小文件 → 跳过
     */
    public async downloadToLocal(
        tasks: ICloudDownloadTask[],
        options?: ICloudDownloadOptions,
    ): Promise<ICloudDownloadResult> {
        const result: ICloudDownloadResult = {
            downloaded: 0,
            skipped: 0,
            failed: 0,
            lyrics: 0,
            errors: [],
        };
        if (!tasks?.length) return result;

        const config = this.readWebdavConfig();
        if (!config) throw new Error('webdav_data_not_complete');

        // 与「下载管理」使用同一个下载目录配置（未配置时用应用默认下载目录）
        const downloadDir =
            this.appConfig.getConfigByKey('download.path') ??
            globalContext.appPath.defaultDownloadPath;
        await fsp.mkdir(downloadDir, { recursive: true });
        console.log(`[CloudDisk] 下载到本地目录: ${downloadDir}`);

        const client = this.createClient(config);
        let processed = 0;

        for (const task of tasks) {
            processed += 1;
            const remoteName = path.basename(task.remotePath);
            const displayName = task.title || remoteName;
            try {
                const ext = path.extname(remoteName).toLowerCase();
                const base = task.artist?.trim()
                    ? `${task.title?.trim() || path.parse(remoteName).name} - ${task.artist.trim()}`
                    : task.title?.trim() || path.parse(remoteName).name;
                const localPath = path.join(downloadDir, `${sanitizeFileName(base)}${ext}`);

                this.broadcastProgress(processed, tasks.length, path.basename(localPath));

                // 远端大小（用于判断本地是否已有同一份）
                let remoteSize = 0;
                try {
                    const stat = await client.stat(toStoredPath(task.remotePath));
                    remoteSize = Number((stat as { size?: number })?.size ?? 0);
                } catch {
                    // 取不到大小就照常下载
                }

                if (remoteSize > 0) {
                    try {
                        const localStat = await fsp.stat(localPath);
                        if (localStat.size === remoteSize) {
                            result.skipped += 1;
                            this.registerDownloadRecord(task, localPath);
                            if (options?.withLyrics) {
                                result.lyrics += await this.restoreLyric(base, downloadDir);
                            }
                            continue;
                        }
                    } catch {
                        // 本地没有，继续下载
                    }
                }

                // 流式下载，避免大文件占内存
                await new Promise<void>((resolve, reject) => {
                    const readStream = client.createReadStream(toStoredPath(task.remotePath));
                    const writeStream = fs.createWriteStream(localPath);
                    readStream.on('error', reject);
                    writeStream.on('error', reject);
                    writeStream.on('finish', () => resolve());
                    readStream.pipe(writeStream);
                });

                result.downloaded += 1;
                this.registerDownloadRecord(task, localPath);
                if (options?.withLyrics) {
                    result.lyrics += await this.restoreLyric(base, downloadDir);
                }
            } catch (err) {
                result.failed += 1;
                result.errors.push(
                    `${displayName}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        return result;
    }

    /**
     * 把云盘歌词目录里的同名歌词恢复成本地 .lrc。
     *
     * 落地位置与「下载设置 → 歌词下载路径」一致：配了就用它，没配就跟随歌曲目录。
     * 「恢复」语义 → 覆盖本地同名歌词（用户是主动点恢复的）。
     *
     * @param base 歌曲主名（`<歌名 - 歌手>`，与云盘歌词文件名同规则）
     * @returns 1 = 恢复成功，0 = 云盘没有这份歌词
     */
    private async restoreLyric(base: string, downloadDir: string): Promise<number> {
        try {
            const text = await this.getLyricText(base);
            if (!text?.trim()) return 0;

            const configuredDir = this.appConfig.getConfigByKey('download.lyricPath')?.trim();
            const lyricDir = configuredDir || downloadDir;
            await fsp.mkdir(lyricDir, { recursive: true });

            const fileName = sanitizeFileName(base);
            await fsp.writeFile(path.join(lyricDir, `${fileName}.lrc`), text, {
                encoding: 'utf-8',
                flag: 'w',
            });
            return 1;
        } catch (err) {
            console.warn('[CloudDisk] 恢复歌词失败:', err);
            return 0;
        }
    }

    /**
     * 写入「下载管理」所需的两条记录：
     * 1. __downloaded__ 系统歌单（下载管理页就是列它）
     * 2. mediaMeta 下载路径（让「本地优先」取源命中）
     */
    private registerDownloadRecord(task: ICloudDownloadTask, localPath: string): void {
        const musicId = String(task.musicId);
        try {
            // 优先用库里已有的完整数据，避免覆盖 title/album 等字段
            const existing = this.musicItemProvider?.getRawMusicItem(task.platform, musicId);
            const item: IMusic.IMusicItem = existing ?? {
                platform: task.platform,
                id: musicId,
                title: task.title,
                artist: task.artist,
            };
            this.downloadedSheet.addMusicToDownloaded(item);
        } catch (err) {
            console.warn('[CloudDisk] 写入已下载歌单失败:', err);
        }

        try {
            this.mediaMeta.setMeta(
                task.platform,
                musicId,
                {
                    downloadData: { path: localPath, quality: 'standard', at: Date.now() },
                },
                { title: task.title, artist: task.artist },
            );
        } catch (err) {
            console.warn('[CloudDisk] 写入下载记录失败:', err);
        }

        // 3. 登记进文件真值层：这份文件从此是「本地有」，
        //    取源/歌词/传云端按文件真值命中，删掉下载记录也不影响
        try {
            this.localFileRegister?.({
                filePath: localPath,
                platform: task.platform,
                id: musicId,
                title: task.title,
                artist: task.artist,
                quality: 'standard',
            });
        } catch (err) {
            console.warn('[CloudDisk] 登记本地文件失败:', err);
        }
    }

    /** 手动上传过的单曲清单（供选择性恢复） */
    public getManualUploads(): ICloudUploadRecord[] {
        return (this.queries?.getManualUploads.all() ?? []) as ICloudUploadRecord[];
    }

    /** 全部上传清单（自动同步对账用） */
    public getAllUploads(): ICloudUploadRecord[] {
        return (this.queries?.getAllUploads.all() ?? []) as ICloudUploadRecord[];
    }

    /**
     * 只删上传清单里的记录，**不动云端文件**。
     *
     * 和 `moveToTrash`（连云端文件一起处理）配对使用：
     * 「移除记录」是纯记账操作 —— 下载管理列表里那条「已传云端」消失，
     * 但网盘上的文件还在（适合「我只想清掉这条记录」的场景）。
     *
     * 删完广播一次变更：`cloudSource`（云端图标）和下载管理列表都靠它刷新。
     *
     * @returns 实际删掉的记录数（清单主键 = platform + musicId + remotePath）
     */
    public deleteUploadRecords(records: ICloudUploadIdentity[]): number {
        const list = records.filter((row) => row?.remotePath);
        if (!list.length) return 0;

        let deleted = 0;
        for (const row of list) {
            try {
                const info = this.queries.deleteByIdentityPath.run(
                    row.platform,
                    String(row.musicId),
                    row.remotePath,
                );
                deleted += info.changes;
            } catch (err) {
                console.warn('[CloudDisk] 删除上传记录失败:', err);
            }
        }

        if (deleted) this.invalidate();
        return deleted;
    }

    /**
     * 把远端文件移入回收目录 /MusicFree/trash（不物理删除），并清理清单记录。
     * @returns 实际移动成功的数量
     */
    public async moveToTrash(remotePaths: string[]): Promise<number> {
        const paths = remotePaths.filter(Boolean);
        if (!paths.length) return 0;

        const config = this.readWebdavConfig();
        if (!config) throw new Error('webdav_data_not_complete');

        const client = this.createClient(config);
        if (!(await client.exists(CLOUD_TRASH_DIR))) {
            await client.createDirectory(CLOUD_TRASH_DIR);
        }

        let moved = 0;
        for (const inputPath of paths) {
            // 调用方给的可能两种形态：
            //   - 清单/下载管理：逻辑路径 `/MusicFree/music/歌名 - 歌手.ext`
            //   - 云端音乐页：条目的 id，也就是**服务端映射名** `…_hash.ext.zip`
            // 先归一成逻辑路径：清清单要用它（清单里存的是逻辑路径），
            // 转动文件时再映射成服务端存的名字（toStoredName 幂等，两边都能用）。
            const logicalPath = toLogicalPath(inputPath);
            const remotePath = toStoredPath(logicalPath);
            try {
                // 远端已经没有这个文件（在别的客户端删过 / 上次只删了一半）：
                // 直接把清单记录清掉 —— 否则清单里会留一条永远删不掉的幽灵记录，
                // 「云端已有」图标也会一直亮着。
                if (!(await client.exists(remotePath))) {
                    this.queries.deleteByRemotePath.run(logicalPath);
                    moved += 1;
                    continue;
                }

                const base = path.basename(remotePath);
                const ext = path.extname(base);
                const baseName = ext ? base.slice(0, base.length - ext.length) : base;
                let target = `${CLOUD_TRASH_DIR}/${base}`;
                // 回收站里重名时用「歌名 (1).ext」这种可读后缀，避免看着像乱码
                if (await client.exists(target)) {
                    for (let i = 1; i <= 99; i++) {
                        const candidate = `${CLOUD_TRASH_DIR}/${baseName} (${i})${ext}`;
                        if (!(await client.exists(candidate))) {
                            target = candidate;
                            break;
                        }
                    }
                }
                await client.moveFile(remotePath, target);
                this.queries.deleteByRemotePath.run(logicalPath);
                moved += 1;
            } catch (err) {
                console.warn(
                    `[CloudDisk] 移入回收站失败 ${inputPath}:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }

        this.invalidate();
        return moved;
    }

    // ─── 对外能力 ───

    /**
     * 云盘音乐列表（转成 IMusicItem）。
     * @param force 跳过缓存重新拉取
     */
    public async getMusicItems(force = false): Promise<IMusic.IMusicItem[]> {
        const cacheFresh = this.cachedItems && Date.now() - this.cachedAt < LIST_CACHE_TTL_MS;
        if (!force && cacheFresh) return this.cachedItems as IMusic.IMusicItem[];

        const config = this.readWebdavConfig();
        if (!config) {
            this.connected = false;
            this.lastError = 'webdav_data_not_complete';
            return [];
        }

        try {
            const client = this.createClient(config);
            const files = await this.listRemoteFiles(client);
            const items = files.map((file) => this.buildMusicItem(file));
            this.cachedItems = items;
            this.cachedAt = Date.now();
            this.buildNameIndex(files);
            this.connected = true;
            this.lastError = undefined;
            return items;
        } catch (err) {
            this.connected = false;
            this.lastError = err instanceof Error ? err.message : String(err);
            throw new Error(this.lastError);
        }
    }

    /** 连接状态（不抛错，供页面显示） */
    public async getStatus(): Promise<ICloudStatus> {
        return {
            configured: !!this.readWebdavConfig(),
            connected: this.connected,
            musicDir: CLOUD_MUSIC_DIR,
            error: this.lastError,
        };
    }

    /** 测试连通性（不抛错） */
    public async testConnection(): Promise<ICloudStatus> {
        try {
            await this.getMusicItems(true);
        } catch {
            // 状态已在 getMusicItems 内记录
        }
        return this.getStatus();
    }

    /**
     * 上传到 /MusicFree/music（歌名 - 歌手.ext）。
     *
     * 每个任务两种走法：
     *   - 有 `filePath`：读本地文件直传（增量：远端同名同大小则跳过）
     *   - 没有 `filePath`：这首歌本地没有文件 → 主进程自己取源，**边下边传**，不落磁盘
     *
     * 并发 UPLOAD_CONCURRENCY，逐条广播进度。
     */
    public async uploadTasks(
        tasks: ICloudUploadTask[],
        source: ICloudUploadSource = 'auto',
    ): Promise<ICloudUploadResult> {
        const result: ICloudUploadResult = { uploaded: 0, skipped: 0, failed: 0, errors: [] };
        if (!tasks.length) return result;

        const config = this.readWebdavConfig();
        if (!config) throw new Error('webdav_data_not_complete');

        const client = this.createClient(config);
        await this.ensureMusicDir(client);

        // 远端现状（文件名 → 大小），用于增量跳过
        const remoteSizes = new Map<string, number>();
        for (const file of await this.listRemoteFiles(client)) {
            remoteSizes.set(file.name, file.size);
        }

        const queue = [...tasks];
        let processed = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                const task = queue.shift();
                if (!task) return;
                processed += 1;

                let displayName = task.title || task.filePath || '';
                try {
                    if (task.filePath) {
                        const stat = await fsp.stat(task.filePath);
                        if (!stat.isFile()) throw new Error('不是文件');

                        const ext = path.extname(task.filePath).toLowerCase();
                        const fileName = `${sanitizeFileName(this.buildUploadBase(task, task.filePath))}${ext}`;
                        displayName = fileName;
                        this.broadcastProgress(processed, tasks.length, fileName);

                        if (remoteSizes.get(fileName) === stat.size) {
                            result.skipped += 1;
                            this.recordUpload(task, fileName, stat.size, source);
                            continue;
                        }

                        // 远端存的是映射名（Zotero-only 的 DAV 只放行 .zip 结尾的上传）
                        await client.putFileContents(
                            `${CLOUD_MUSIC_DIR}/${toStoredName(fileName)}`,
                            fs.createReadStream(task.filePath),
                            { overwrite: true, contentLength: stat.size },
                        );
                        remoteSizes.set(fileName, stat.size);
                        result.uploaded += 1;
                        this.recordUpload(task, fileName, stat.size, source);
                        continue;
                    }

                    // 没有本地文件：取源边下边传（不落磁盘）
                    const outcome = await this.uploadFromSource(
                        task,
                        client,
                        remoteSizes,
                        source,
                        (name) => {
                            displayName = name;
                            this.broadcastProgress(processed, tasks.length, name);
                        },
                    );
                    if (outcome === 'skipped') result.skipped += 1;
                    else result.uploaded += 1;
                } catch (err) {
                    result.failed += 1;
                    result.errors.push(
                        `${displayName}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, () => worker()),
        );

        this.invalidate();
        return result;
    }

    /**
     * 生成可播放的本地转发地址。
     * 没有配置 / 转发器未就绪时返回原始 WebDAV 直链（可能因鉴权失败，仅作兜底）。
     */
    public buildStreamUrl(remotePath: string): string {
        const config = this.readWebdavConfig();
        if (!config) return '';

        const target = joinRemoteUrl(config.url, remotePath);
        const port = requestForwarder.getPort();
        if (!port) return target;

        const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
        const params = new URLSearchParams();
        params.set('url', target);
        // 转发器拿着这些头去取上游文件：Zotero-only 的 DAV 连取流也认 UA
        params.set(
            'headers',
            JSON.stringify({ Authorization: auth, ...davExtraHeaders(config.url) }),
        );
        return `http://127.0.0.1:${port}/?${params.toString()}`;
    }

    /**
     * 读取云盘歌词文本。
     *
     * 目录约定：/MusicFree/lyrics/<歌名 - 歌手>.lrc（文件名与音频同名，方便对账）。
     * 找不到 / 云盘未配置时返回 null（歌词取源链会继续往插件走）。
     *
     * 匹配分两级：
     *   1. 精确文件名（与写入时同一套映射，最省事）
     *   2. 归一化「歌名+歌手」再扫一遍目录 —— 同一首歌各插件的歌手写法不同
     *      （`周杰伦&Lara梁心颐` / `周杰伦, Lara梁心颐` / `周杰伦、Lara梁心颐`），
     *      文件名精确比会漏掉，归一化后才是同一首（与音频取源同一套规则）
     */
    public async getLyricText(name: string): Promise<string | null> {
        const fileName = this.safeLyricFileName(name);
        if (!fileName) return null;

        try {
            const client = await this.ensureLyricDir();
            if (!client) return null;

            // 服务端存的是映射名：写和读都用同一个纯函数映射，两边算出来一致
            const remotePath = `${CLOUD_LYRIC_DIR}/${toStoredName(fileName)}`;
            if (await client.exists(remotePath)) {
                const content = await client.getFileContents(remotePath, { format: 'text' });
                return typeof content === 'string' ? content : String(content ?? '');
            }

            const parsed = parseCloudFileName(fileName);
            const wanted = buildMediaNameKey(parsed.title, parsed.artist);
            if (!wanted) return null;

            const hit = (await this.listLyricFiles()).find(
                (file) => buildMediaNameKey(file.title, file.artist) === wanted,
            );
            if (!hit) return null;

            const content = await client.getFileContents(hit.remotePath, { format: 'text' });
            return typeof content === 'string' ? content : String(content ?? '');
        } catch {
            return null;
        }
    }

    /**
     * 上传歌词文本到云盘歌词目录（备份用）。
     *
     * @returns 是否成功
     */
    public async putLyricText(name: string, text: string): Promise<boolean> {
        const fileName = this.safeLyricFileName(name);
        if (!fileName || !text) return false;

        try {
            const client = await this.ensureLyricDir();
            if (!client) return false;

            await client.putFileContents(`${CLOUD_LYRIC_DIR}/${toStoredName(fileName)}`, text, {
                overwrite: true,
            });
            // 远端歌词目录变了：清缓存 + 广播，让云端音乐页 / 歌词管理 / 歌词搜索
            // 的「云盘来源」都按同一套事件刷新（不然只有调用方自己知道）
            this.invalidate();
            return true;
        } catch (err) {
            console.warn('[CloudDisk] 上传歌词失败:', err);
            return false;
        }
    }

    /**
     * 列出云盘歌词目录下的所有歌词文件。
     *
     * 歌词搜索弹窗的「云盘」来源用；文件名为 `<歌名 - 歌手>.lrc`。
     * 云盘未配置 / 目录不存在时返回空数组。
     */
    public async listLyricFiles(): Promise<ICloudLyricFile[]> {
        try {
            const config = this.readWebdavConfig();
            if (!config) return [];
            const client = this.createClient(config);

            let entries: unknown;
            try {
                entries = await client.getDirectoryContents(CLOUD_LYRIC_DIR);
            } catch (err) {
                if (isNotFoundError(err)) return [];
                throw err;
            }

            const list: Array<Record<string, any>> = Array.isArray(entries)
                ? (entries as Array<Record<string, any>>)
                : ((entries as { data?: Array<Record<string, any>> })?.data ?? []);

            return list
                .filter((entry) => entry?.type === 'file')
                .map((entry) => {
                    const storedName = String(
                        entry.basename ?? path.basename(String(entry.filename ?? '')),
                    );
                    const rawPath = String(entry.filename ?? `${CLOUD_LYRIC_DIR}/${storedName}`);
                    // 展示/解析用逻辑名（`<歌名 - 歌手>.lrc`），取流仍用服务端存的映射名
                    const fileName = toLogicalName(storedName);
                    const { artist, title } = parseCloudFileName(fileName);
                    return {
                        name: fileName,
                        remotePath: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
                        title: title || fileName.replace(/\.lrc$/i, ''),
                        artist,
                        size: Number(entry.size ?? 0),
                    };
                })
                .filter((file) => /\.lrc$/i.test(file.name))
                .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        } catch (err) {
            console.warn('[CloudDisk] 列出歌词文件失败:', err);
            return [];
        }
    }

    /** 把歌词名规整成安全的 .lrc 文件名 */
    private safeLyricFileName(name: string): string | null {
        const trimmed = (name ?? '').trim();
        if (!trimmed) return null;
        const base = trimmed.replace(/\.lrc$/i, '').replace(/[\\/:*?"<>|]/g, '_');
        return `${base}.lrc`;
    }

    /** 确保歌词目录存在并返回 client（云盘未配置时返回 null） */
    private async ensureLyricDir(): Promise<WebDAVClient | null> {
        const config = this.readWebdavConfig();
        if (!config) return null;
        const client = this.createClient(config);
        try {
            for (const dir of ['/MusicFree', CLOUD_LYRIC_DIR]) {
                if (!(await client.exists(dir))) await client.createDirectory(dir);
            }
        } catch {
            return null;
        }
        return client;
    }

    public async findStreamUrl(item: { title?: string; artist?: string }): Promise<string | null> {
        const title = item?.title?.trim();
        if (!title) return null;

        if (!this.cachedItems) {
            try {
                await this.getMusicItems();
            } catch {
                return null;
            }
        }

        let remotePath = this.cachedByName.get(normalizeKey(item.artist ?? '', title));
        if (!remotePath) {
            // 歌手缺失/未知时才允许「歌名唯一」兜底，
            // 否则「别人的翻唱」会被静默替换成云盘里同名但不同歌手的版本。
            const artist = (item.artist ?? '').trim();
            const isUnknownArtist = !artist || artist === i18n.t('media.unknown_artist');
            if (isUnknownArtist) {
                const sameTitle = this.cachedByTitle.get(normalizeTitleKey(title));
                if (sameTitle?.length === 1) remotePath = sameTitle[0];
            }
        }
        if (!remotePath) return null;

        return this.buildStreamUrl(remotePath) || null;
    }

    /** 清空缓存并广播（外部改动远端后可调用） */
    public invalidate(): void {
        this.cachedItems = null;
        this.cachedAt = 0;
        this.cachedByName.clear();
        this.cachedByTitle.clear();
        this.windowManager?.broadcast(IPC.FILES_CHANGED, null);
    }

    // ─── 内部实现 ───

    private readWebdavConfig(): IWebdavConfig | null {
        const url = this.appConfig.getConfigByKey('backup.webdav.url');
        const username = this.appConfig.getConfigByKey('backup.webdav.username');
        const password = this.appConfig.getConfigByKey('backup.webdav.password');
        if (!url || !username || !password) return null;
        return { url, username, password };
    }

    private createClient(config: IWebdavConfig): WebDAVClient {
        return createClient(config.url, {
            authType: AuthType.Password,
            username: config.username,
            password: config.password,
            // Zotero-only 的 DAV（如数据胶囊）会按 UA 判客户端类型，不带就 403
            headers: davExtraHeaders(config.url),
        });
    }

    /** 确保远端目录存在 */
    private async ensureMusicDir(client: WebDAVClient): Promise<void> {
        for (const dir of ['/MusicFree', CLOUD_MUSIC_DIR]) {
            if (!(await client.exists(dir))) {
                await client.createDirectory(dir);
            }
        }
    }

    /**
     * 远端文件名的主干：`<歌名> - <歌手>`。
     *
     * 歌名缺失时退回本地文件名（没有本地文件就用记录里的歌名，再没有只能是「未命名」）。
     */
    private buildUploadBase(task: ICloudUploadTask, localFilePath?: string): string {
        const fallbackTitle = localFilePath ? path.parse(localFilePath).name : '';
        const title = task.title?.trim() || fallbackTitle;
        const artist = task.artist?.trim();
        return artist ? `${title || '未命名'} - ${artist}` : title || '未命名';
    }

    /**
     * 「本地没有文件」时的上传：主进程取源 → 边下边传，不落本地磁盘。
     *
     * 流程：插件取音源（音质回退与下载同一套）→ Electron net GET →
     * 读文件头定扩展名 → 远端同名同大小则跳过 → 否则把响应流直接 PUT 给 WebDAV。
     *
     * 记录写进上传清单时 `local_path` 为空：这类条目本来就没有本地文件，
     * 云端对账也不该把它当孤儿（见 common/syncPlan.ts）。
     *
     * @returns 本次是「传上去了」还是「远端已有、跳过」
     */
    private async uploadFromSource(
        task: ICloudUploadTask,
        client: WebDAVClient,
        remoteSizes: Map<string, number>,
        source: ICloudUploadSource,
        onFileName: (fileName: string) => void,
    ): Promise<'uploaded' | 'skipped'> {
        if (!this.pluginManager) throw new Error('音源解析不可用');

        const musicItem = this.resolveUploadMusicItem(task);
        if (!musicItem) throw new Error('缺少歌曲信息，无法取源');

        const quality =
            this.appConfig.getConfigByKey('download.defaultQuality') ?? ('standard' as const);
        const media = await this.pluginManager.getMediaSource(
            musicItem,
            quality,
            QUALITY_KEYS,
            this.appConfig.getConfigByKey('download.whenQualityMissing') ?? 'lower',
        );
        if (!media?.url) throw new Error('无法获取音源');

        const headers: Record<string, string> = { ...(media.headers ?? {}) };
        if (media.userAgent) headers['User-Agent'] = media.userAgent;

        const opened = await openSourceStream(media.url, headers);
        const fileName = `${sanitizeFileName(this.buildUploadBase(task))}${opened.ext}`;
        onFileName(fileName);

        if (opened.size > 0 && remoteSizes.get(fileName) === opened.size) {
            (opened.stream as unknown as { destroy?: () => void }).destroy?.();
            this.recordUpload(task, fileName, opened.size, source);
            return 'skipped';
        }

        try {
            await client.putFileContents(
                `${CLOUD_MUSIC_DIR}/${toStoredName(fileName)}`,
                opened.stream,
                {
                    overwrite: true,
                    // 有 Content-Length 就带上（某些 DAV 网关不收 chunked PUT）
                    ...(opened.size > 0 ? { contentLength: opened.size } : {}),
                },
            );
        } catch (err) {
            (opened.stream as unknown as { destroy?: () => void }).destroy?.();
            throw err;
        }

        remoteSizes.set(fileName, opened.size);
        this.recordUpload(task, fileName, opened.size, source);
        return 'uploaded';
    }

    /**
     * 取源要用的歌曲数据：库里能找到完整条目就用它（插件可能依赖 album/duration 等字段），
     * 否则用清单/任务里那几个字段拼一条。
     */
    private resolveUploadMusicItem(task: ICloudUploadTask): IMusic.IMusicItem | null {
        if (!task.platform) return null;
        const musicId = task.id != null ? String(task.id) : '';
        const existing = musicId
            ? this.musicItemProvider?.getRawMusicItem(task.platform, musicId)
            : null;
        if (existing) return existing;
        return {
            platform: task.platform,
            id: musicId || `${task.title ?? ''}`,
            title: task.title ?? '',
            artist: task.artist ?? '',
        };
    }

    /** 上传成功后写入清单（手动上传过的条目不会被自动上传降级） */
    private recordUpload(
        task: ICloudUploadTask,
        fileName: string,
        size: number,
        source: ICloudUploadSource,
    ): void {
        try {
            this.queries.upsertUpload.run({
                platform: task.platform ?? CLOUD_PLUGIN_NAME,
                musicId: task.id != null ? String(task.id) : fileName,
                title: task.title ?? '',
                artist: task.artist ?? '',
                remotePath: `${CLOUD_MUSIC_DIR}/${fileName}`,
                // 从音源直传的条目没有本地文件 → 留空（对账时不能当孤儿，见 syncPlan）
                localPath: task.filePath ?? null,
                source,
                size,
                uploadedAt: Date.now(),
                // 作品键：云端「已上传」状态与孤儿对账都按作品算，不按插件身份算
                workKey: buildMediaNameKey(task.title, task.artist) || null,
            });
        } catch (err) {
            console.warn('[CloudDisk] 写入上传清单失败:', err);
        }
    }

    /** 广播上传进度 */
    private broadcastProgress(current: number, total: number, name: string): void {
        const payload: ICloudUploadProgress = { current, total, name };
        this.windowManager?.broadcast(IPC.UPLOAD_PROGRESS, payload);
    }

    /** PROPFIND 远端音乐目录 → 音频文件列表 */
    private async listRemoteFiles(client: WebDAVClient): Promise<ICloudFile[]> {
        let entries: unknown;
        try {
            entries = await client.getDirectoryContents(CLOUD_MUSIC_DIR);
        } catch (err) {
            // 目录还不存在（还没上传过）→ 空列表
            if (isNotFoundError(err)) return [];
            throw err;
        }

        const list: Array<Record<string, any>> = Array.isArray(entries)
            ? (entries as Array<Record<string, any>>)
            : ((entries as { data?: Array<Record<string, any>> })?.data ?? []);

        return list
            .filter((entry) => entry?.type === 'file')
            .map((entry) => {
                const storedName = String(
                    entry.basename ?? path.basename(String(entry.filename ?? '')),
                );
                const rawPath = String(entry.filename ?? `${CLOUD_MUSIC_DIR}/${storedName}`);
                // name 用逻辑名（`歌名 - 歌手.ext`）供解析歌名/歌手、增量比对；
                // path 保持服务端存的映射名，取流/下载直接用
                const name = toLogicalName(storedName);
                return {
                    path: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
                    name,
                    ext: path.extname(name).toLowerCase(),
                    size: Number(entry.size ?? 0),
                    mtime: entry.lastmod ? Date.parse(String(entry.lastmod)) : null,
                };
            })
            .filter((file) => SUPPORTED_AUDIO_EXTS.has(file.ext))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    }

    /** 建立「歌名/歌手 → 远端路径」索引 */
    private buildNameIndex(files: ICloudFile[]): void {
        this.cachedByName.clear();
        this.cachedByTitle.clear();
        for (const file of files) {
            const { artist, title } = parseCloudFileName(file.name);
            this.cachedByName.set(normalizeKey(artist, title), file.path);
            const titleKey = normalizeTitleKey(title);
            const list = this.cachedByTitle.get(titleKey) ?? [];
            list.push(file.path);
            this.cachedByTitle.set(titleKey, list);
        }
    }

    /** ICloudFile → IMusicItem */
    private buildMusicItem(file: ICloudFile): IMusic.IMusicItem {
        const { artist, title } = parseCloudFileName(file.name);
        return {
            platform: CLOUD_PLUGIN_NAME,
            id: file.path,
            title: title || file.name,
            artist: artist || i18n.t('media.unknown_artist'),
            album: '',
            duration: undefined,
            artwork: undefined,
            // 兜底播放地址：插件 getMediaSource 也会返回同样内容
            url: this.buildStreamUrl(file.path),
            // 云盘专有字段（IMusicItem 有索引签名）
            cloudPath: file.path,
            cloudName: file.name,
            cloudSize: file.size,
            cloudMtime: file.mtime,
            cloudExt: file.ext,
        };
    }
}

const cloudDisk = new CloudDiskManager();
export default cloudDisk;
