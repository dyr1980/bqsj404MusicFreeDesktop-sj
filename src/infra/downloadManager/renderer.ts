/**
 * downloadManager — Renderer 层
 *
 * 职责：
 * - 下载任务列表管理（分页加载）
 * - 实时下载进度追踪（IPC 广播）
 * - 已下载歌曲 O(1) 查询（内存 Map + useSyncExternalStore）
 * - 代理所有下载操作 IPC 调用
 */

import { useSyncExternalStore, useCallback } from 'react';
import EventEmitter from 'eventemitter3';
import { compositeKey } from '@common/mediaKey';
import { normalizeArtistKey, normalizeTitleKey, buildMediaNameKey } from '@common/mediaNameKey';
import debounce from '@common/debounce';
import { CONTEXT_BRIDGE_KEY } from './common/constant';
import type {
    IDownloadTask,
    IDownloadProgress,
    IDownloadTaskEvent,
    IAddDownloadParams,
    ActiveDownloadStatus,
} from '@appTypes/infra/downloadManager';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

// ─── Preload Bridge ───

interface IMod {
    addTask(params: IAddDownloadParams): Promise<IDownloadTask>;
    addTasksBatch(params: {
        musicItems: Array<IMusic.IMusicItem | IMusicItemSlim>;
        quality?: IMusic.IQualityKey;
    }): Promise<IDownloadTask[]>;
    pauseTask(taskId: string): Promise<void>;
    resumeTask(taskId: string): Promise<void>;
    removeTask(taskId: string): Promise<void>;
    removeDownload(platform: string, musicId: string, deleteFile?: boolean): Promise<void>;
    retryTask(taskId: string): Promise<void>;
    clearTaskError(taskId: string): Promise<void>;
    pauseAll(): Promise<void>;
    resumeAll(): Promise<void>;
    getTasks(page: number, pageSize: number): Promise<{ data: IDownloadTask[]; total: number }>;
    getAllTasks(): Promise<IDownloadTask[]>;
    getAllDownloaded(): Promise<
        Array<{
            platform: string;
            musicId: string;
            path: string;
            quality: IMusic.IQualityKey;
            title?: string;
            artist?: string;
            workKey?: string;
            /** 记录下载的时间（ms，老记录可能缺失） */
            downloadedAt?: number;
        }>
    >;
    onProgress(cb: (data: { tasks: IDownloadProgress[] }) => void): () => void;
    onTaskEvent(cb: (event: IDownloadTaskEvent) => void): () => void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

/**
 * 歌名 / 歌手的比对键统一走 mediaNameKey：
 * 同一首歌各来源写法不一（`周杰伦&Lara梁心颐` / `周杰伦, Lara梁心颐` / `周杰伦、Lara梁心颐`），
 * 只按原始字符串比会漏掉本地文件。详见该模块注释。
 */
const titleKeyOf = normalizeTitleKey;
const artistKeyOf = normalizeArtistKey;

/** 一条「已下载」记录（三个索引共用同一个对象，保证快照引用稳定） */
interface IDownloadedEntry {
    path: string;
    quality: IMusic.IQualityKey;
    platform: string;
    musicId: string;
}

// ─── DownloadManagerRenderer ───

interface IRendererEvents {
    downloadChange: () => void;
    taskListChange: () => void;
    activeTaskChange: () => void;
}

class DownloadManagerRenderer {
    // ─── 代理方法 ───

    addTask = mod.addTask.bind(mod);
    addTasksBatch = mod.addTasksBatch.bind(mod);
    pauseTask = mod.pauseTask.bind(mod);
    resumeTask = mod.resumeTask.bind(mod);
    /** 删除活跃下载任务（pending/downloading/paused/error） */
    removeTask = mod.removeTask.bind(mod);
    /** 删除已完成的下载（本地文件 + 歌单 + mediaMeta） */
    removeDownload = mod.removeDownload.bind(mod);
    retryTask = mod.retryTask.bind(mod);
    /** 清除失败状态（error → 已暂停，不自动重跑） */
    clearTaskError = mod.clearTaskError.bind(mod);
    pauseAll = mod.pauseAll.bind(mod);
    resumeAll = mod.resumeAll.bind(mod);

    private isSetup = false;

    /** 下载任务列表 */
    private tasks: IDownloadTask[] = [];
    /** 任务总数 */
    private totalCount = 0;

    /** 实时下载进度 */
    private progressMap = new Map<string, IDownloadProgress>();

    /**
     * 已下载歌曲索引 Map<compositeKey, entry>。
     *
     * 三个索引共用**同一批 entry 对象**（不再每次新建）：
     * useMusicDownloaded 通过 useSyncExternalStore 依赖快照的引用稳定，
     * 每次返回新对象会导致无限重渲染。
     */
    private downloadedMap = new Map<string, IDownloadedEntry>();

    /**
     * 「歌名|歌手」索引：同一首歌在别的插件下 id 不同，靠名字兜底命中本地文件。
     * @see findLocalFile
     */
    private downloadedByName = new Map<string, IDownloadedEntry>();
    /** 「歌名」索引（歌手未知/为空时的唯一性兜底） */
    private downloadedByTitle = new Map<string, IDownloadedEntry[]>();

    /**
     * 「作品键」索引：归一化(歌名|歌手)，与插件无关。
     *
     * 这是本地匹配的**正式**一级 —— 同一首作品在酷我/QQ歌词/元力KW 下 id 各不相同，
     * 只按 (platform, id) 或「歌名+歌手」字符串比都只是在模拟「作品身份」。
     * 有了它，换插件播同一首歌、批量切源之后都能直接命中本地文件。
     */
    private downloadedByWorkKey = new Map<string, IDownloadedEntry>();

    /**
     * 活跃下载任务状态索引 Map<compositeKey, { status, taskId }>
     *
     * 仅在 taskEvent（added/status-changed/completed/removed）时更新，
     * 不受高频 progress 广播影响，保证 useMusicDownloadTask 性能。
     */
    private activeTaskMap = new Map<string, { status: ActiveDownloadStatus; taskId: string }>();
    private activeTaskVersion = 0;

    private events = new EventEmitter<IRendererEvents>();

    private taskListVersion = 0;

    /** IPC 事件取消订阅函数 */
    private unsubProgress: (() => void) | null = null;
    private unsubTaskEvent: (() => void) | null = null;

    /** 防抖刷新任务列表（批量下载时避免高频 IPC） */
    private debouncedRefresh = debounce(async () => {
        try {
            const tasks = await mod.getAllTasks();
            this.tasks = tasks;
            this.totalCount = tasks.length;
            this.taskListVersion++;
            this.events.emit('taskListChange');
        } catch (e) {
            console.error('[downloadManager] refresh failed:', e);
        }
    }, 300);

    async setup(): Promise<void> {
        if (this.isSetup) return;

        // 加载初始任务列表
        const tasks = await mod.getAllTasks();
        this.tasks = tasks;
        this.totalCount = tasks.length;

        // 从初始任务列表构建 activeTaskMap
        for (const task of tasks) {
            if (task.status !== 'completed') {
                const key = compositeKey(task.platform, task.musicId);
                this.activeTaskMap.set(key, {
                    status: task.status as ActiveDownloadStatus,
                    taskId: task.id,
                });
            }
        }

        // C1: 从 mediaMeta 构建 downloadedMap（已完成下载不再存于 download_tasks）
        const downloaded = await mod.getAllDownloaded();
        this.rebuildIndexes(downloaded);

        // H4: 监听进度广播（保存 unsubscribe）
        this.unsubProgress = mod.onProgress(({ tasks }) => {
            for (const p of tasks) {
                this.progressMap.set(p.id, p);
            }
            this.taskListVersion++;
            this.events.emit('taskListChange');
        });

        // H4: 监听任务事件（保存 unsubscribe）
        this.unsubTaskEvent = mod.onTaskEvent((event) => {
            const key = compositeKey(event.task.platform, event.task.musicId);

            // ── 更新 activeTaskMap（独立于 progress，保证 useMusicDownloadTask 性能）──
            if (event.type === 'completed' || event.type === 'removed') {
                this.activeTaskMap.delete(key);
            } else {
                // completed 已在上方分支处理，此处 status 不会是 completed
                this.activeTaskMap.set(key, {
                    status: event.task.status as ActiveDownloadStatus,
                    taskId: event.task.id,
                });
            }
            this.activeTaskVersion++;
            this.events.emit('activeTaskChange');

            // ── 更新已下载索引 ──
            if (event.type === 'completed' && event.task.filePath) {
                // 全部索引都要更新（主键 / 作品键 / 歌名+歌手 / 歌名）。
                // 只更主键的话，「同一首歌换个插件播」时 findLocalFile 当场查不到 ——
                // 明明刚下完、本地文件就在，却掉到云盘/插件去播。
                this.indexEntry(
                    {
                        path: event.task.filePath,
                        quality: event.task.quality,
                        platform: event.task.platform,
                        musicId: String(event.task.musicId),
                    },
                    event.task.title,
                    event.task.artist,
                );
                this.events.emit('downloadChange');
                // 再和 mediaMeta 对一次账：那边的歌名/歌手来自 music_items，更完整
                void this.refreshDownloaded();
            }

            if (event.type === 'removed') {
                if (this.downloadedMap.has(key)) {
                    this.events.emit('downloadChange');
                }
                // 删除同样要重建索引，否则「歌名+歌手」里还留着已删除的文件
                void this.refreshDownloaded();
            }

            // 清理已完成/已删除任务的进度缓存
            if (event.type === 'completed' || event.type === 'removed') {
                this.progressMap.delete(event.task.id);
            }

            // 刷新任务列表（防抖）
            this.debouncedRefresh();
        });

        this.isSetup = true;
    }

    // ─── 任务列表查询 ───

    getTasks(): IDownloadTask[] {
        return this.tasks;
    }

    getTotalCount(): number {
        return this.totalCount;
    }

    getProgress(taskId: string): IDownloadProgress | undefined {
        return this.progressMap.get(taskId);
    }

    /** 全部已下载记录（platform/musicId/path/quality + 时间），供云盘上传、下载管理列表使用 */
    getAllDownloaded(): Promise<
        Array<{
            platform: string;
            musicId: string;
            path: string;
            quality: IMusic.IQualityKey;
            title?: string;
            artist?: string;
            workKey?: string;
            downloadedAt?: number;
        }>
    > {
        return mod.getAllDownloaded();
    }

    /**
     * 重新从 mediaMeta 拉取已下载列表。
     * 供「外部模块直接写入 mediaMeta 下载记录」后刷新本地缓存使用（如云盘下载到本地）。
     */
    async refreshDownloaded(): Promise<void> {
        try {
            const downloaded = await mod.getAllDownloaded();
            this.rebuildIndexes(downloaded);
            this.events.emit('downloadChange');
        } catch (e) {
            console.error('[downloadManager] refreshDownloaded failed:', e);
        }
    }

    // ─── 已下载状态查询（O(1)） ───

    /**
     * 查询是否已下载（O(1)，只认精确的 platform+id）。
     *
     * 「批量切到本地」会把队列项的 platform 改写成 本地/云盘，而下载记录仍然挂在
     * 原始平台上（`originPlatform` / `originId`）——所以主键查不到时按原始身份再查一次，
     * 否则切换来源之后本地文件就再也命不中了。
     */
    isDownloaded(item: {
        platform: string;
        id: string;
        originPlatform?: string;
        originId?: string;
    }): { path: string; quality: IMusic.IQualityKey } | null {
        return this.getDownloadedByItemKey(item);
    }

    /**
     * 找这首歌对应的本地文件——**取源用**，比 isDownloaded 宽一档。
     *
     * 命中顺序：
     *   1. platform + id（精确）
     *   2. originPlatform + originId（「切到本地/云盘」后的原始身份）
     *   3. **作品键**（归一化 歌名|歌手）—— 与插件无关的作品身份，
     *      这是「换了插件播同一首歌 / 自动换源之后还能命中本地文件」的正式依据
     *   4. 歌名 + 歌手（历史记录没有作品键时的兜底，语义同 3）
     *   5. 歌名唯一且歌手未知/为空时，认那一份
     *
     * @returns 命中时连带返回它记录在案的 platform/musicId，便于调用方清理失效记录
     */
    findLocalFile(item: {
        platform: string;
        id: string;
        originPlatform?: string;
        originId?: string;
        title?: string;
        artist?: string;
    }): IDownloadedEntry | null {
        const byKey = this.getDownloadedByItemKey(item);
        if (byKey) return byKey;

        const workKey = buildMediaNameKey(item.title, item.artist);
        if (workKey) {
            const byWork = this.downloadedByWorkKey.get(workKey);
            if (byWork) return byWork;
        }

        const title = titleKeyOf(item.title);
        if (!title) return null;

        const byName = this.downloadedByName.get(`${title}|${artistKeyOf(item.artist)}`);
        if (byName) return byName;

        if (!artistKeyOf(item.artist)) {
            const sameTitle = this.downloadedByTitle.get(title);
            if (sameTitle?.length === 1) return sameTitle[0];
        }
        return null;
    }

    /** 通过 compositeKey 查询下载记录（返回索引里的同一个对象，引用稳定） */
    getDownloadedByKey(key: string): IDownloadedEntry | null {
        return this.downloadedMap.get(key) ?? null;
    }

    /**
     * 按「作品键 / 歌名+歌手」查本地文件（不含主键分支），返回稳定引用。
     * 供 useMusicDownloaded 用：列表里的下载标记要和实际播出音源保持一致。
     */
    getDownloadedByName(title?: string, artist?: string): IDownloadedEntry | null {
        const workKey = buildMediaNameKey(title, artist);
        if (workKey) {
            const byWork = this.downloadedByWorkKey.get(workKey);
            if (byWork) return byWork;
        }

        const normalizedTitle = titleKeyOf(title);
        if (!normalizedTitle) return null;
        const byName = this.downloadedByName.get(`${normalizedTitle}|${artistKeyOf(artist)}`);
        if (byName) return byName;
        if (!artistKeyOf(artist)) {
            const sameTitle = this.downloadedByTitle.get(normalizedTitle);
            if (sameTitle?.length === 1) return sameTitle[0];
        }
        return null;
    }

    // ─── 订阅 ───

    subscribeDownloadChange = (cb: () => void): (() => void) => {
        this.events.on('downloadChange', cb);
        return () => this.events.off('downloadChange', cb);
    };

    subscribeTaskListChange = (cb: () => void): (() => void) => {
        this.events.on('taskListChange', cb);
        return () => this.events.off('taskListChange', cb);
    };

    getTaskListSnapshot = (): number => {
        return this.taskListVersion;
    };

    subscribeActiveTaskChange = (cb: () => void): (() => void) => {
        this.events.on('activeTaskChange', cb);
        return () => this.events.off('activeTaskChange', cb);
    };

    /** 通过 compositeKey 查询活跃任务状态（O(1)） */
    getActiveTaskStatus(key: string): ActiveDownloadStatus | null {
        return this.activeTaskMap.get(key)?.status ?? null;
    }

    /** 通过 musicItem 重试失败的下载任务 */
    async retryByMusicItem(item: { platform: string; id: string }): Promise<void> {
        const key = compositeKey(item.platform, String(item.id));
        const entry = this.activeTaskMap.get(key);
        if (entry?.status === 'error') {
            await mod.retryTask(entry.taskId);
        } else if (entry?.status === 'paused') {
            await mod.resumeTask(entry.taskId);
        }
    }

    /**
     * 通过 musicItem 清除失败状态（列表上的红色失败图标点一下用）。
     * 效果：任务变成灰色「已暂停」，图标回到普通下载图标；不会自动重跑。
     */
    async clearErrorByMusicItem(item: { platform: string; id: string }): Promise<void> {
        const key = compositeKey(item.platform, String(item.id));
        const entry = this.activeTaskMap.get(key);
        if (entry?.status === 'error') {
            await mod.clearTaskError(entry.taskId);
        }
    }

    dispose(): void {
        this.unsubProgress?.();
        this.unsubProgress = null;
        this.unsubTaskEvent?.();
        this.unsubTaskEvent = null;
        this.events.removeAllListeners();
        this.activeTaskMap.clear();
        this.downloadedMap.clear();
        this.progressMap.clear();
        this.tasks = [];
        this.totalCount = 0;
        this.isSetup = false;
    }

    /** 由已下载清单重建全部索引（主键 / 歌名+歌手 / 歌名） */
    private rebuildIndexes(
        downloaded: Array<{
            platform: string;
            musicId: string;
            path: string;
            quality: IMusic.IQualityKey;
            title?: string;
            artist?: string;
            workKey?: string;
        }>,
    ): void {
        this.downloadedMap.clear();
        this.downloadedByName.clear();
        this.downloadedByTitle.clear();
        this.downloadedByWorkKey.clear();

        for (const item of downloaded) {
            // 全量重建：map 已清空，不必查重
            this.mapEntry(
                {
                    path: item.path,
                    quality: item.quality,
                    platform: item.platform,
                    musicId: item.musicId,
                },
                item.title,
                item.artist,
                item.workKey,
            );
        }
    }

    /**
     * 把一条下载记录写进四个索引（主键 / 作品键 / 歌名+歌手 / 歌名）。
     *
     * 同一首歌会被不同插件以不同 id 播（「如愿」在元力KW / 酷我 / 弥音QQ 各有 id），
     * 所以光有主键索引不够 —— 作品键和「歌名+歌手」都得在下载完成的当下建好，
     * 否则刚下完的歌换个插件播 / 在另一个歌单里看，都认不出本地文件。
     */
    private indexEntry(
        entry: IDownloadedEntry,
        title?: string,
        artist?: string,
        workKey?: string,
    ): void {
        this.removeFromNameIndexes(compositeKey(entry.platform, entry.musicId));
        this.mapEntry(entry, title, artist, workKey);
    }

    /** 直接写入四个索引（不查重） */
    private mapEntry(
        entry: IDownloadedEntry,
        title?: string,
        artist?: string,
        workKey?: string,
    ): void {
        this.downloadedMap.set(compositeKey(entry.platform, entry.musicId), entry);

        const key = workKey || buildMediaNameKey(title, artist);
        if (key) this.downloadedByWorkKey.set(key, entry);

        const normalizedTitle = titleKeyOf(title);
        if (!normalizedTitle) return;
        this.downloadedByName.set(`${normalizedTitle}|${artistKeyOf(artist)}`, entry);
        const sameTitle = this.downloadedByTitle.get(normalizedTitle) ?? [];
        sameTitle.push(entry);
        this.downloadedByTitle.set(normalizedTitle, sameTitle);
    }

    /** 从「作品键」「歌名+歌手」「歌名」三个索引里摘掉某条记录（重下 / 删除 / 换路径时用） */
    private removeFromNameIndexes(key: string): void {
        for (const [workKey, entry] of this.downloadedByWorkKey) {
            if (compositeKey(entry.platform, entry.musicId) === key) {
                this.downloadedByWorkKey.delete(workKey);
            }
        }
        for (const [nameKey, entry] of this.downloadedByName) {
            if (compositeKey(entry.platform, entry.musicId) === key) {
                this.downloadedByName.delete(nameKey);
            }
        }
        for (const [title, list] of this.downloadedByTitle) {
            const next = list.filter((e) => compositeKey(e.platform, e.musicId) !== key);
            if (next.length === list.length) continue;
            if (next.length) this.downloadedByTitle.set(title, next);
            else this.downloadedByTitle.delete(title);
        }
    }

    /** 精确（或原始身份）命中时，取出索引里的那条记录 */
    private getDownloadedByItemKey(item: {
        platform: string;
        id: string;
        originPlatform?: string;
        originId?: string;
    }): IDownloadedEntry | null {
        const direct = this.downloadedMap.get(compositeKey(item.platform, String(item.id)));
        if (direct) return direct;
        if (item.originPlatform && item.originId) {
            return (
                this.downloadedMap.get(compositeKey(item.originPlatform, String(item.originId))) ??
                null
            );
        }
        return null;
    }
}

const downloadManager = new DownloadManagerRenderer();
export default downloadManager;

// ═══════════════════════════════════════════════════════
// React Hooks
// ═══════════════════════════════════════════════════════

/**
 * 查询歌曲是否**有下载记录** — 同步 O(1)，仅在下载状态变化时触发 re-render。
 *
 * ⚠️ 这是「记录」不是「文件」：记录在、文件被外部删掉时它照样返回命中的那份。
 * 需要「本地到底有没有这个文件」（列表/按钮上的本地图标、队列徽标、换源可用性）请用
 * `@renderer/mainWindow/core/localSource`（按文件系统校验），别拿这个当文件状态用。
 *
 * 匹配口径与取源一致（`findLocalFile`）：主键 → 原始身份 → 歌名+歌手。
 * 否则「换了个插件播同一首歌」时会用本地文件播放、列表却标成「未下载」。
 *
 * 性能保证：
 * - 下载进度变化（onProgress）仅触发 taskListChange，不会触发此 hook。
 * - 仅 completed/removed 事件触发 downloadChange。
 * - 当 downloadChange 触发时，所有订阅者的 getSnapshot 被调用（O(1) Map 查找）。
 *   未变化的对象返回同一引用 → Object.is 判定相同 → 不 re-render。
 */
export function useMusicDownloaded(
    musicItem:
        | {
              platform: string;
              id: string;
              originPlatform?: string;
              originId?: string;
              title?: string;
              artist?: string;
          }
        | null
        | undefined,
): { path: string; quality: IMusic.IQualityKey } | null {
    const key = musicItem ? compositeKey(musicItem.platform, String(musicItem.id)) : null;
    // 「切到本地」后 platform 被改写，原始身份的下载记录仍要能查到
    const originKey =
        musicItem?.originPlatform && musicItem?.originId
            ? compositeKey(musicItem.originPlatform, String(musicItem.originId))
            : null;
    const title = musicItem?.title;
    const artist = musicItem?.artist;

    const getSnapshot = useCallback(() => {
        if (!key) return null;
        return (
            downloadManager.getDownloadedByKey(key) ??
            (originKey ? downloadManager.getDownloadedByKey(originKey) : null) ??
            downloadManager.getDownloadedByName(title, artist)
        );
    }, [key, originKey, title, artist]);

    return useSyncExternalStore(downloadManager.subscribeDownloadChange, getSnapshot);
}

/**
 * 获取下载任务列表 — 任务列表变化时触发 re-render。
 */
export function useDownloadTasks(): IDownloadTask[] {
    useSyncExternalStore(
        downloadManager.subscribeTaskListChange,
        downloadManager.getTaskListSnapshot,
    );
    return downloadManager.getTasks();
}

/**
 * 查询歌曲的活跃下载任务状态 — O(1)，仅在任务事件时触发 re-render。
 *
 * 性能保证：
 * - 独立于 onProgress 广播（不受高频进度事件影响）。
 * - 仅 taskEvent（added/status-changed/completed/removed）触发 activeTaskChange。
 * - Map O(1) 查找 + Object.is 判定：状态未变的按钮不会 re-render。
 *
 * @returns 活跃任务的 ActiveDownloadStatus（pending/downloading/paused/error），无任务时返回 null。
 */
export function useMusicDownloadTask(
    musicItem: { platform: string; id: string } | null | undefined,
): ActiveDownloadStatus | null {
    const key = musicItem ? compositeKey(musicItem.platform, String(musicItem.id)) : null;

    const getSnapshot = useCallback(
        () => (key ? downloadManager.getActiveTaskStatus(key) : null),
        [key],
    );

    return useSyncExternalStore(downloadManager.subscribeActiveTaskChange, getSnapshot);
}

/**
 * 获取指定任务的下载进度。
 */
export function useDownloadProgress(taskId: string): IDownloadProgress | undefined {
    useSyncExternalStore(
        downloadManager.subscribeTaskListChange,
        downloadManager.getTaskListSnapshot,
    );
    return downloadManager.getProgress(taskId);
}
