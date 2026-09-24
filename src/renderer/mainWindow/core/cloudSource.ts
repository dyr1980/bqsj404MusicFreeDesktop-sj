/**
 * cloudSource — 渲染层「这首歌云盘上到底有没有文件」索引
 *
 * 为什么要有它：
 *   云端按钮 / 队列徽标 / 换源弹窗都要回答「云端有没有这份」。答案以前来自
 *   **上传清单**（`cloud_uploads`）——那是记账表：在网盘侧删掉文件、或者只清掉记录，
 *   图标就会和真实文件不一致。所以这里改成问**云盘本身**。
 *
 * 数据来源：`cloudDisk.getAllItems()`（PROPFIND 真实远端列表，主进程有 60s 缓存，
 * 所以重复调用不会反复打网络）。匹配按**作品键**（归一化 歌名|歌手）——同一首歌换个
 * 插件播/下载，(platform,id) 会变，但作品键不变；歌名唯一时对「歌手未知」再兜一层。
 *
 * 刷新时机：启动、云盘内容变化广播（上传 / 移入回收站）、上传成功后主动刷、窗口重新聚焦
 * （复用 60s 缓存，不会每次打网络）。云端不可达时保留上一次结果，不清空。
 */

import { useCallback, useSyncExternalStore } from 'react';
import cloudDisk from '@infra/cloudDisk/renderer';
import type { ICloudStatus } from '@appTypes/infra/cloudDisk';
import { buildMediaNameKey, normalizeTitleKey } from '@common/mediaNameKey';

type Listener = () => void;

/** 窗口聚焦触发的重查间隔（对应主进程 60s 列表缓存） */
const FOCUS_REFRESH_INTERVAL_MS = 60 * 1000;

class CloudSourceStore {
    private isSetup = false;

    /** 真实远端文件索引 */
    private items: IMusic.IMusicItem[] = [];
    /** 作品键（归一化 歌名|歌手）→ 远端条目 */
    private byWorkKey = new Map<string, IMusic.IMusicItem>();
    /** 归一化歌名 → 远端条目列表（歌手未知时按唯一性兜底） */
    private byTitle = new Map<string, IMusic.IMusicItem[]>();
    /** 真实远端路径 */
    private paths = new Set<string>();

    /** 首次拉取是否完成（没完成时 UI 显示「检查中」而不是「没有」） */
    private ready = false;
    /** 最近一次是否读取成功（未配置 / 网络失败时为 false） */
    private ok = false;
    /** 云盘是否已配置 */
    private configured = false;

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
            const unsub = cloudDisk.onFilesChanged(() => void this.refresh({ force: true }));
            this.disposeFns.push(unsub);
        } catch {
            // 忽略：订阅失败不影响聚焦刷新
        }

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
        this.items = [];
        this.byWorkKey.clear();
        this.byTitle.clear();
        this.paths.clear();
        this.ready = false;
        this.isSetup = false;
    }

    /**
     * 重新读取远端文件列表并重建索引。
     *
     * 读失败（未配置 / 断网）时**保留上一次结果**，避免整屏云端图标瞬间熄灭。
     */
    public async refresh(opts?: { force?: boolean; minInterval?: number }): Promise<void> {
        if (this.refreshing) return this.refreshing;

        const minInterval = opts?.force ? 0 : (opts?.minInterval ?? 0);
        if (minInterval && Date.now() - this.lastRefreshAt < minInterval) return;

        const task = this.reload()
            .catch((err) => {
                console.warn('[cloudSource] 读取云盘列表失败:', err);
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

    /** 列表是否已读到过（false = 还在查） */
    public isReady(): boolean {
        return this.ready;
    }

    /** 最近一次读取是否成功 / 云盘是否已配置 */
    public getStatus(): { configured: boolean; ok: boolean; ready: boolean } {
        return { configured: this.configured, ok: this.ok, ready: this.ready };
    }

    /** 这首歌云盘上有没有文件 */
    public hasItem(item: {
        platform: string;
        id: string;
        title?: string;
        artist?: string;
    }): boolean {
        return this.getRemoteItem(item) !== null;
    }

    /**
     * 云盘上对应的那个条目（换源要拿它的远端路径当播放地址）。
     * 找不到返回 null。
     */
    public getRemoteItem(item: {
        platform?: string;
        id?: string;
        title?: string;
        artist?: string;
    }): IMusic.IMusicItem | null {
        if (!item) return null;

        const workKey = buildMediaNameKey(item.title, item.artist);
        if (workKey) {
            const hit = this.byWorkKey.get(workKey);
            if (hit) return hit;
        }

        // 歌手缺失/未知时才允许「歌名唯一」兜底，
        // 否则「别人的翻唱」会被静默当成云盘里的同名文件
        const titleKey = normalizeTitleKey(item.title);
        if (!titleKey) return null;
        const sameTitle = this.byTitle.get(titleKey);
        return sameTitle?.length === 1 ? sameTitle[0] : null;
    }

    /** 远端路径集合（调试 / 对账用） */
    public getRemotePaths(): string[] {
        return [...this.paths];
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
                console.error('[cloudSource] listener error:', e);
            }
        }
    }

    /** 拉远端列表 → 重建「作品键 / 歌名」索引 */
    private async reload(): Promise<void> {
        const status = await cloudDisk.getStatus().catch((): ICloudStatus | null => null);
        this.configured = !!status?.configured;

        if (!this.configured) {
            this.items = [];
            this.byWorkKey.clear();
            this.byTitle.clear();
            this.paths.clear();
            this.ok = false;
            return;
        }

        const items = (await cloudDisk.getAllItems()) ?? [];
        const byWorkKey = new Map<string, IMusic.IMusicItem>();
        const byTitle = new Map<string, IMusic.IMusicItem[]>();
        const paths = new Set<string>();

        for (const item of items) {
            if (!item) continue;
            // 云盘条目的 id 是**服务端存的映射名**（`歌名 - 歌手_hash.ext.zip`），不是上传清单里的
            // 逻辑路径（`/MusicFree/music/歌名 - 歌手.ext`）—— 两者不能直接比，要比得先过 toStoredPath。
            // 所以「云端有没有这首」一律按作品键匹配（下面），不做路径比对。
            if (typeof item.id === 'string' && item.id) paths.add(item.id);

            const workKey = buildMediaNameKey(item.title, item.artist);
            if (workKey && !byWorkKey.has(workKey)) byWorkKey.set(workKey, item);

            const titleKey = normalizeTitleKey(item.title);
            if (!titleKey) continue;
            const sameTitle = byTitle.get(titleKey) ?? [];
            sameTitle.push(item);
            byTitle.set(titleKey, sameTitle);
        }

        this.items = items;
        this.byWorkKey = byWorkKey;
        this.byTitle = byTitle;
        this.paths = paths;
        this.ok = true;
    }
}

const cloudSource = new CloudSourceStore();
export default cloudSource;

/**
 * 这首歌云盘上有没有文件。
 *
 * 只在列表变化时重渲染（快照是布尔值，引用天然稳定）。
 */
export function useMusicOnCloud(
    musicItem: { platform: string; id: string; title?: string; artist?: string } | null | undefined,
): boolean {
    const platform = musicItem?.platform;
    const id = musicItem ? String(musicItem.id) : undefined;
    const title = musicItem?.title;
    const artist = musicItem?.artist;

    const getSnapshot = useCallback(() => {
        if (!platform || id === undefined) return false;
        return cloudSource.hasItem({ platform, id, title, artist });
    }, [platform, id, title, artist]);

    return useSyncExternalStore(cloudSource.subscribe, getSnapshot);
}

/** 云端列表是否已就绪（false = 还在查，用于「检查中」文案） */
export function useCloudSourceReady(): boolean {
    return useSyncExternalStore(cloudSource.subscribe, () => cloudSource.isReady());
}
