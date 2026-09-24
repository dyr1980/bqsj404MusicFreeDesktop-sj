/**
 * localSource — 渲染层「这首歌本地到底有没有文件」索引
 *
 * 为什么要有它：
 *   「已下载」以前是拿**下载记录**（media_meta.download_path）当答案的 —— 记录在但文件
 *   被外部删掉时图标照样亮着（说本地有、点开文件夹是空的）；反过来本地库里的歌只要
 *   记录被清掉，图标又会灭。本地图标必须和**磁盘上的文件**一致，所以这里把答案改成
 *   「文件真的存在」。
 *
 * 数据来源（两条，都只当**候选**用）：
 *   1. 下载记录 `downloadManager.getAllDownloaded()`（App 下载的歌；下载目录不一定在扫描范围内）
 *   2. 本地音乐库 `localMusic.getAllMusicItems()`（扫描到的文件）
 * 候选路径统一过一遍存在性校验（preload 直接 stat，不走 IPC），**只把真实存在的**写进索引。
 *
 * 「本地有没有文件」的权威就是本索引（= 文件真值）；下载记录只在两件事上参与：
 *   - 提供**扫描范围外**的候选路径（下载目录可能没被加入扫描目录）
 *   - 提供**登记音质**（`quality`，用于音质匹配与展示；纯扫描文件为 null = 未知）
 * 主进程侧对应实现是 `localMusic.lookupFile()`（同一套匹配顺序），两者必须保持一致。
 *
 * 匹配规则与取源一致（`downloadManager.findLocalFile`）：主键 → 原始身份 → 作品键 →
 * 歌名+歌手 → 歌名唯一兜底，所以「换个插件播同一首歌」也能命中同一份本地文件。
 *
 * 刷新时机：启动、下载记录变化、本地音乐库变化、窗口重新聚焦（有节流）。
 * 外部删文件不会发任何事件，靠窗口聚焦/下一次刷新补上。
 */

import { useCallback, useSyncExternalStore } from 'react';
import downloadManager from '@infra/downloadManager/renderer';
import localMusic from '@infra/localMusic/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import { compositeKey } from '@common/mediaKey';
import { normalizeArtistKey, normalizeTitleKey, buildMediaNameKey } from '@common/mediaNameKey';
import { LOCAL_PLUGIN_NAME } from '@common/constant';

/** 索引里一条「本地真的有文件」的记录 */
interface ILocalFileEntry {
    path: string;
    platform: string;
    id: string;
    /** 登记音质（来自下载记录）；null = 未知（纯扫描入库的文件） */
    quality?: IMusic.IQualityKey | null;
}

/** 查询时的条目形状（完整/精简都行） */
export interface ILocalFileQuery {
    platform: string;
    id: string;
    title?: string;
    artist?: string;
    originPlatform?: string;
    originId?: string;
    localPath?: string;
}

type Listener = () => void;

/** 存在性校验并发（本地几百上千个文件也不至于一次打爆 I/O） */
const EXISTS_CONCURRENCY = 32;

/** 普通刷新节流：短时间内多次事件只校验一次 */
const MIN_REFRESH_INTERVAL_MS = 3 * 1000;

/** 窗口聚焦触发的重校验间隔（外部删文件靠它兜底） */
const FOCUS_REFRESH_INTERVAL_MS = 30 * 1000;

/** 批量校验哪些路径真的存在（preload 里的 fs，没有 IPC 开销） */
async function filterExistingPaths(paths: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(paths.filter(Boolean))];
    const existing = new Set<string>();

    for (let i = 0; i < unique.length; i += EXISTS_CONCURRENCY) {
        const batch = unique.slice(i, i + EXISTS_CONCURRENCY);
        const results = await Promise.all(
            batch.map(async (filePath) => ((await fsUtil.isFile(filePath)) ? filePath : null)),
        );
        for (const filePath of results) {
            if (filePath) existing.add(filePath);
        }
    }

    return existing;
}

class LocalSourceStore {
    private isSetup = false;

    /** 首次校验是否完成（未完成前用记录兜底，避免启动瞬间满屏「未下载」） */
    private ready = false;
    /** 真实存在的路径 */
    private paths = new Set<string>();
    /** platform\0id → 记录 */
    private byKey = new Map<string, ILocalFileEntry>();
    /** 作品键（归一化 歌名|歌手）→ 记录 */
    private byWorkKey = new Map<string, ILocalFileEntry>();
    /** 归一化 歌名|歌手 → 记录（历史记录没有作品键时的兜底） */
    private byName = new Map<string, ILocalFileEntry>();
    /** 归一化歌名 → 记录列表（歌手未知时按唯一性兜底） */
    private byTitle = new Map<string, ILocalFileEntry[]>();

    private listeners = new Set<Listener>();
    private version = 0;
    private refreshing: Promise<void> | null = null;
    private lastRefreshAt = 0;
    private disposeFns: Array<() => void> = [];

    public setup(): void {
        if (this.isSetup) return;
        this.isSetup = true;

        void this.refresh({ force: true });

        try {
            const unsubDownload = downloadManager.subscribeDownloadChange(
                () => void this.refresh(),
            );
            this.disposeFns.push(unsubDownload);
        } catch {
            // 忽略：订阅失败不影响后续聚焦刷新
        }
        try {
            const unsubLibrary = localMusic.onLibraryChanged(() => void this.refresh());
            this.disposeFns.push(unsubLibrary);
        } catch {
            // 忽略
        }

        // 外部删文件不会发事件：窗口重新聚焦 / 页面重新可见时再校验一遍（有节流）
        const onFocus = (): void => {
            void this.refresh({ minInterval: FOCUS_REFRESH_INTERVAL_MS });
        };
        window.addEventListener('focus', onFocus);
        const onVisible = (): void => {
            if (!document.hidden) onFocus();
        };
        document.addEventListener('visibilitychange', onVisible);
        this.disposeFns.push(() => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisible);
        });
    }

    public dispose(): void {
        for (const fn of this.disposeFns) fn();
        this.disposeFns = [];
        this.listeners.clear();
        this.paths.clear();
        this.byKey.clear();
        this.byWorkKey.clear();
        this.byName.clear();
        this.byTitle.clear();
        this.ready = false;
        this.isSetup = false;
    }

    /**
     * 重新校验「本地有哪些文件」。
     *
     * @param force 跳过节流
     * @param minInterval 本次调用的最小间隔（不传用默认节流）
     */
    public async refresh(opts?: { force?: boolean; minInterval?: number }): Promise<void> {
        if (this.refreshing) return this.refreshing;

        const minInterval = opts?.force ? 0 : (opts?.minInterval ?? MIN_REFRESH_INTERVAL_MS);
        if (!opts?.force && Date.now() - this.lastRefreshAt < minInterval) return;

        const task = this.rebuild()
            .catch((err) => {
                console.warn('[localSource] 校验本地文件失败:', err);
            })
            .finally(() => {
                this.lastRefreshAt = Date.now();
                this.ready = true;
                this.refreshing = null;
                this.emit();
            });

        this.refreshing = task;
        return task;
    }

    /** 首次校验是否已完成 */
    public isReady(): boolean {
        return this.ready;
    }

    /**
     * 等待首次「文件真值」校验完成。
     *
     * 启动恢复播放时可能早于索引建好（那一瞬间只有下载记录管用），
     * 于是本地音乐库里的文件会被漏掉，播放直接掉到云端/插件。
     * 这里最多等 timeoutMs：建好了立即返回，等不到就用当前索引继续（不阻塞播放）。
     */
    public async whenReady(timeoutMs = 3000): Promise<boolean> {
        if (this.ready) return true;
        if (!this.isSetup) this.setup();

        const inflight = this.refreshing ?? this.refresh({ force: true });
        await Promise.race([
            inflight.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
        return this.ready;
    }

    /** 这首歌本地有没有文件 */
    public has(item: ILocalFileQuery): boolean {
        return this.getEntry(item) !== null;
    }

    /** 这首歌对应的本地文件路径（没有文件返回 null） */
    public getPath(item: ILocalFileQuery): string | null {
        return this.getEntry(item)?.path || null;
    }

    /** 索引里的记录（内部/取源用） */
    public getEntry(item: ILocalFileQuery): ILocalFileEntry | null {
        if (!item) return null;

        // 还没校验完 → 先用记录兜底（避免启动瞬间全部显示「未下载」）
        if (!this.ready) return this.legacyEntry(item);

        // 条目自带的 localPath：只有校验通过（文件真的在）才算
        if (item.localPath && this.paths.has(item.localPath)) {
            return { path: item.localPath, platform: item.platform, id: String(item.id) };
        }

        const direct = this.byKey.get(compositeKey(item.platform, String(item.id)));
        if (direct) return direct;

        // 「切到本地/云盘」后 platform 被改写，原始身份的记录仍要能查到
        if (item.originPlatform && item.originId) {
            const origin = this.byKey.get(compositeKey(item.originPlatform, String(item.originId)));
            if (origin) return origin;
        }

        const workKey = buildMediaNameKey(item.title, item.artist);
        if (workKey) {
            const byWork = this.byWorkKey.get(workKey);
            if (byWork) return byWork;
        }

        const titleKey = normalizeTitleKey(item.title);
        if (!titleKey) return null;

        const byName = this.byName.get(`${titleKey}|${normalizeArtistKey(item.artist)}`);
        if (byName) return byName;

        // 歌手缺失/未知时才允许「歌名唯一」兜底
        if (!normalizeArtistKey(item.artist)) {
            const sameTitle = this.byTitle.get(titleKey);
            if (sameTitle?.length === 1) return sameTitle[0];
        }

        return null;
    }

    public subscribe = (cb: Listener): (() => void) => {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    };

    /** 索引版本号（快照里要带上它，值变化才会触发重渲染） */
    public getVersion = (): number => this.version;

    private emit(): void {
        this.version++;
        for (const cb of this.listeners) {
            try {
                cb();
            } catch (e) {
                console.error('[localSource] listener error:', e);
            }
        }
    }

    /** 首次校验完成前的兜底：按下载记录 / 本地音乐库条目判断（老行为） */
    private legacyEntry(item: ILocalFileQuery): ILocalFileEntry | null {
        if (item.localPath) {
            return { path: item.localPath, platform: item.platform, id: String(item.id) };
        }
        if (item.platform === LOCAL_PLUGIN_NAME) {
            return { path: '', platform: item.platform, id: String(item.id) };
        }
        const downloaded = downloadManager.findLocalFile(item);
        if (downloaded) {
            return {
                path: downloaded.path,
                platform: downloaded.platform,
                id: downloaded.musicId,
                quality: downloaded.quality ?? null,
            };
        }
        return null;
    }

    /** 收集候选 → 校验存在性 → 重建索引 */
    private async rebuild(): Promise<void> {
        type TDownloadedRecord = Awaited<
            ReturnType<typeof downloadManager.getAllDownloaded>
        >[number];
        type TLibraryItem = Awaited<ReturnType<typeof localMusic.getAllMusicItems>>[number];

        const [records, library] = await Promise.all([
            downloadManager.getAllDownloaded().catch((): TDownloadedRecord[] => []),
            localMusic.getAllMusicItems().catch((): TLibraryItem[] => []),
        ]);

        const candidates: Array<ILocalFileEntry & { title: string; artist: string }> = [];
        /** 路径 → 登记音质（下载记录提供；纯扫描文件没有） */
        const qualityByPath = new Map<string, IMusic.IQualityKey>();
        for (const record of records ?? []) {
            if (!record?.path) continue;
            if (record.quality) qualityByPath.set(record.path, record.quality);
            candidates.push({
                path: record.path,
                platform: record.platform,
                id: String(record.musicId),
                title: record.title ?? '',
                artist: record.artist ?? '',
            });
        }
        for (const item of library ?? []) {
            const filePath = typeof item?.localPath === 'string' ? item.localPath : '';
            if (!filePath) continue;
            candidates.push({
                path: filePath,
                platform: item.platform,
                id: String(item.id),
                title: item.title ?? '',
                artist: item.artist ?? '',
            });
        }

        const existing = await filterExistingPaths(candidates.map((c) => c.path));

        const paths = new Set<string>();
        const byKey = new Map<string, ILocalFileEntry>();
        const byWorkKey = new Map<string, ILocalFileEntry>();
        const byName = new Map<string, ILocalFileEntry>();
        const byTitle = new Map<string, ILocalFileEntry[]>();

        for (const candidate of candidates) {
            if (!existing.has(candidate.path)) continue;
            const entry: ILocalFileEntry = {
                path: candidate.path,
                platform: candidate.platform,
                id: candidate.id,
                // 音质只作「音质匹配 / 展示」用：来自下载记录，纯扫描文件为 null（未知）
                quality: qualityByPath.get(candidate.path) ?? null,
            };
            paths.add(entry.path);
            byKey.set(compositeKey(entry.platform, entry.id), entry);

            const workKey = buildMediaNameKey(candidate.title, candidate.artist);
            if (workKey) byWorkKey.set(workKey, entry);

            const titleKey = normalizeTitleKey(candidate.title);
            if (!titleKey) continue;
            byName.set(`${titleKey}|${normalizeArtistKey(candidate.artist)}`, entry);
            const sameTitle = byTitle.get(titleKey) ?? [];
            sameTitle.push(entry);
            byTitle.set(titleKey, sameTitle);
        }

        this.paths = paths;
        this.byKey = byKey;
        this.byWorkKey = byWorkKey;
        this.byName = byName;
        this.byTitle = byTitle;
    }
}

const localSource = new LocalSourceStore();
export default localSource;

/**
 * 这首歌对应的本地文件路径（null = 本地没有文件）。
 *
 * 比 `useMusicLocalFile` 多给一个路径（换源弹窗要显示「文件在哪」）。
 */
export function useMusicLocalPath(musicItem: ILocalFileQuery | null | undefined): string | null {
    const platform = musicItem?.platform;
    const id = musicItem ? String(musicItem.id) : undefined;
    const title = musicItem?.title;
    const artist = musicItem?.artist;
    const originPlatform = musicItem?.originPlatform;
    const originId = musicItem?.originId;
    const localPath = musicItem?.localPath;

    const getSnapshot = useCallback(() => {
        if (!platform || id === undefined) return null;
        return localSource.getPath({
            platform,
            id,
            title,
            artist,
            originPlatform,
            originId,
            localPath,
        });
    }, [platform, id, title, artist, originPlatform, originId, localPath]);

    return useSyncExternalStore(localSource.subscribe, getSnapshot);
}

/**
 * 这首歌本地有没有文件（文件系统为准）。
 *
 * 快照是布尔值，引用天然稳定；只在校验完成 / 文件增删时重渲染。
 */
export function useMusicLocalFile(musicItem: ILocalFileQuery | null | undefined): boolean {
    const platform = musicItem?.platform;
    const id = musicItem ? String(musicItem.id) : undefined;
    const title = musicItem?.title;
    const artist = musicItem?.artist;
    const originPlatform = musicItem?.originPlatform;
    const originId = musicItem?.originId;
    const localPath = musicItem?.localPath;

    const getSnapshot = useCallback(() => {
        if (!platform || id === undefined) return false;
        return localSource.has({
            platform,
            id,
            title,
            artist,
            originPlatform,
            originId,
            localPath,
        });
    }, [platform, id, title, artist, originPlatform, originId, localPath]);

    return useSyncExternalStore(localSource.subscribe, getSnapshot);
}
