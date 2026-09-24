/* eslint-disable @typescript-eslint/member-ordering -- 本文件 public/private 按功能就近排布，不按排序规则 */
/**
 * LyricManager — 歌词获取 & 逐行追踪
 *
 * 通过 pluginManager 获取歌词源，使用 LyricParser 解析，
 * 播放进度变化时更新当前歌词行并写入 jotai atom。
 *
 * 无歌词时可自动换歌词源（对标播放失败的「自动换插件」）：
 * 逐个歌词插件串行搜索，命中即关联并重新加载，避免请求风暴。
 */
import LyricParser from '@common/lyricParser';
import { compositeKey } from '@common/mediaKey';
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';

import i18n from '@infra/i18n/renderer';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import fsUtil from '@infra/fsUtil/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import appConfig from '@infra/appConfig/renderer';
import localSource from '../localSource';
import { store, currentLyricAtom, progressAtom, associatedLyricAtom } from './store';

/** 歌词偏移写入 mediaMeta 的防抖延迟（ms） */
const OFFSET_PERSIST_DELAY = 500;
/** 歌词偏移可调范围（秒），与设置面板的滑块保持一致 */
export const LYRIC_OFFSET_LIMIT = 15;
/** 自动换歌词源时，最多尝试的插件数（避免为一个没有歌词的歌打爆主进程） */
const AUTO_LYRIC_MAX_PLUGINS = 6;
/** 单个插件搜索+取词的超时（ms） */
const AUTO_LYRIC_TIMEOUT_MS = 8000;
/** 找本地同名 .lrc 前，等「文件真值」索引建好的上限（启动恢复可能跑在它前面） */
const LOCAL_LYRIC_READY_MS = 2000;

/** 带超时的 Promise 包装：超时返回 null，不阻塞串行链 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        task.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

class LyricManager {
    private parser: LyricParser | null = null;
    private currentMusicKey: string | null = null;
    /** 当前歌曲的 platform + musicId，用于写入 mediaMeta */
    private currentPlatform: string | null = null;
    private currentMusicId: string | null = null;
    /** 用户调整的歌词偏移（秒），正值表示歌词提前，负值表示歌词延后 */
    private userOffset = 0;
    /** 防抖写入 mediaMeta 的定时器 */
    private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    /** 本首歌是否已经自动换过歌词源（每首歌只自动尝试一次） */
    private autoSearchTried = false;
    /** 正在自动换源，避免并发触发 */
    private isAutoSearching = false;
    /** 当前歌曲的完整信息，供自动换源搜索用 */
    private currentMusicItem: IMusic.IMusicItem | null = null;

    /**
     * 取词世代号：每次 fetchLyric 自增。
     *
     * 「同一首歌」会被取词多次（切歌后的元数据刷新、关联歌词后刷新、设置里打开自动搜索等），
     * 而取词链是异步多级的（本地 → 云盘 → 插件）。只比对 musicKey 挡不住这种并发：
     * 早先那次请求走到最后一级插件、拿到结果时，晚一次请求已经把云盘歌词贴到界面上了，
     * 于是旧结果把新结果覆盖回去。表现就是「云盘歌词命中却显示插件歌词」。
     *
     * 因此每个异步关口都比对世代号，过时的那次请求直接丢弃，不再写 parser / atom。
     */
    private fetchGeneration = 0;

    /** 获取并解析歌词 */
    async fetchLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        const key = compositeKey(musicItem.platform, musicItem.id);
        if (this.currentMusicKey !== key) {
            // 换歌了 → 重置「本首是否已自动换过歌词源」
            this.autoSearchTried = false;
        }
        this.currentMusicKey = key;

        // 「切到本地/云盘」后 platform 会被改写成 本地/云盘，歌词偏移、关联歌词、
        // 下载记录都还挂在原始身份上 —— 取源前先把原始身份解出来
        const origin = this.resolveOrigin(musicItem);
        const lookupItem =
            origin.platform === musicItem.platform
                ? musicItem
                : { ...musicItem, platform: origin.platform, id: origin.id };
        this.currentPlatform = origin.platform;
        this.currentMusicId = origin.id;
        this.currentMusicItem = musicItem;

        // 本次取词的世代号；下面每个 await 之后都要确认自己还是「最新那次」
        const generation = ++this.fetchGeneration;
        const isStale = () => this.fetchGeneration !== generation;

        try {
            // 从 mediaMeta 恢复该歌曲的歌词偏移和关联歌词信息
            const meta = await mediaMeta.getMeta(origin.platform, origin.id, {
                title: lookupItem.title,
                artist: lookupItem.artist,
            });
            if (isStale()) return;
            this.userOffset = meta?.lyricOffset ?? 0;
            store.set(associatedLyricAtom, meta?.associatedLyric?.musicItem ?? null);

            // 取源优先级：手动关联 → 本地 .lrc → 云盘歌词 → 插件
            // 只有「用户手动关联」才短路；自动搜索缓存下来的不能挡住本地 / 云盘歌词
            const associated = meta?.associatedLyric;
            if (associated?.rawLrc && associated.source === 'manual') {
                this.applyLyricText(associated.rawLrc, musicItem, associated.translation);
                return;
            }

            const localLrc = await this.tryLocalLyricFile(lookupItem);
            if (isStale()) return;
            if (localLrc) {
                this.applyLyricText(localLrc, musicItem);
                return;
            }

            const cloudLrc = await this.tryCloudLyricFile(lookupItem);
            if (isStale()) return;
            if (cloudLrc) {
                this.applyLyricText(cloudLrc, musicItem);
                return;
            }

            const lyricSource = await pluginManager.adapters.getLyric(lookupItem);

            // 切歌 / 已有更新的取词请求 → 丢弃旧结果
            if (isStale()) return;

            if (!lyricSource?.rawLrc && !lyricSource?.lrc) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                // 没拿到歌词 → 自动换歌词源（可通过设置关闭）
                void this.tryAutoSearchLyric(key, lookupItem, generation);
                return;
            }

            const pluginLrc = lyricSource.rawLrc ?? lyricSource.lrc ?? '';
            this.applyLyricText(pluginLrc, musicItem, lyricSource.translation);
            // 「是否备份歌词」开着就把这份歌词传到云盘歌词目录
            void this.backupLyricToCloud(lookupItem, pluginLrc);
        } catch {
            if (!isStale()) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                void this.tryAutoSearchLyric(key, lookupItem, generation);
            }
        }
    }

    /**
     * 解出歌曲的「原始身份」。
     *
     * 批量切到本地 / 云盘时，队列项的 platform 会被改写成 本地/云盘，
     * 原始 platform + id 记在 originPlatform / originId 上。
     * 歌词偏移、手动关联歌词、下载记录、插件取词全都按原始身份存，
     * 所以这里统一还原，避免切源之后歌词整条链失效。
     */
    private resolveOrigin(musicItem: IMusic.IMusicItem): { platform: string; id: string } {
        const item = musicItem as IMusic.IMusicItem & {
            originPlatform?: string;
            originId?: string;
        };
        return {
            platform: item.originPlatform ?? musicItem.platform,
            id: String(item.originId ?? musicItem.id),
        };
    }

    /** 根据播放进度更新当前歌词行 */
    updatePosition(currentTime: number): void {
        if (!this.parser) return;

        const lyricItem = this.parser.getPosition(currentTime + this.userOffset);
        const prev = store.get(currentLyricAtom);

        if (prev?.currentLrc?.index !== lyricItem?.index) {
            store.set(currentLyricAtom, {
                parser: this.parser,
                currentLrc: lyricItem ?? undefined,
            });
        }
    }

    /** 重置 */
    reset(): void {
        // 作废所有在途取词（过时的结果不许再写 parser / atom）
        this.fetchGeneration++;
        this.parser = null;
        this.currentMusicKey = null;
        this.currentPlatform = null;
        this.currentMusicId = null;
        this.currentMusicItem = null;
        this.userOffset = 0;
        clearTimeout(this.persistTimer);
        store.set(currentLyricAtom, null);
        store.set(associatedLyricAtom, null);
    }

    /**
     * 重新允许「无歌词时自动搜索」。
     *
     * 用户可能在正播某首歌时打开这个开关，此前的「已尝试过」记录会把这次机会吃掉。
     * 关掉开关时调用本方法清掉记录，之后重新加载歌词就会再试一次。
     */
    allowAutoSearchAgain(): void {
        this.autoSearchTried = false;
    }

    /** 获取当前用户歌词偏移（秒） */
    getUserOffset(): number {
        return this.userOffset;
    }

    /** 设置用户歌词偏移（秒），并立即刷新当前歌词行 */
    setUserOffset(offset: number): void {
        this.userOffset = offset;
        const currentTime = store.get(progressAtom).currentTime;
        this.updatePosition(currentTime);

        // 防抖写入 mediaMeta
        clearTimeout(this.persistTimer);
        const platform = this.currentPlatform;
        const musicId = this.currentMusicId;
        // 作品键要跟着写：换个插件播同一首歌也要能取回这个偏移
        const identity = {
            title: this.currentMusicItem?.title,
            artist: this.currentMusicItem?.artist,
        };
        if (platform && musicId) {
            this.persistTimer = setTimeout(() => {
                // 确保写入时仍是同一首歌
                if (this.currentPlatform !== platform || this.currentMusicId !== musicId) return;
                if (offset === 0) {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: null }, identity);
                } else {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: offset }, identity);
                }
            }, OFFSET_PERSIST_DELAY);
        }
    }

    /** 强制重新加载当前歌曲歌词（用于关联/取消关联歌词后刷新） */
    /** 歌词在云盘上的文件名约定：<歌名 - 歌手>.lrc（和下载文件名一致） */
    private lyricFileName(musicItem: IMusic.IMusicItem): string {
        const artist = (musicItem.artist ?? '').trim();
        const title = (musicItem.title ?? '').trim();
        return artist ? `${title} - ${artist}` : title;
    }

    /** 从云盘歌词目录取歌词（未配置云盘 / 没有该文件时返回 null） */
    private async tryCloudLyricFile(musicItem: IMusic.IMusicItem): Promise<string | null> {
        try {
            const name = this.lyricFileName(musicItem);
            if (!name) return null;
            const text = await cloudDisk.getLyricText(name);
            console.log('[lyric] cloud =', name, '| hit =', !!text);
            return text;
        } catch {
            return null;
        }
    }

    /** 按「是否备份歌词」设置，把歌词传一份到云盘 */
    private async backupLyricToCloud(musicItem: IMusic.IMusicItem, rawLrc: string): Promise<void> {
        try {
            if (!rawLrc) return;
            if (appConfig.getConfigByKey('backup.uploadLyrics') === false) return;
            const name = this.lyricFileName(musicItem);
            if (!name) return;
            await cloudDisk.putLyricText(name, rawLrc);
        } catch {
            /* 备份失败不影响播放 */
        }
    }

    /**
     * 套用一段歌词文本（统一出口：初始定位到当前播放时间）。
     */
    private applyLyricText(
        rawLrc: string,
        musicItem: IMusic.IMusicItem,
        translation?: string,
    ): void {
        this.parser = new LyricParser(rawLrc, { musicItem, translation });
        // C-17: 初始定位到当前播放时间（恢复播放等场景，避免歌词从头开始）
        const currentTime = store.get(progressAtom).currentTime;
        store.set(currentLyricAtom, {
            parser: this.parser,
            currentLrc: this.parser.getPosition(currentTime + this.userOffset) ?? undefined,
        });
    }

    /**
     * 找歌曲同名 .lrc。
     *
     * 查找顺序（歌词取源链的第一级：本地 → 云盘 → 插件）：
     *   1. 歌曲文件同目录（下载目录 / 本地音乐目录，最常见）
     *   2. 「下载设置 → 歌词下载路径」里配的独立歌词目录
     *
     * 目录按「文件名」对账，所以歌词文件与音频不同盘也能对上。
     */
    private async tryLocalLyricFile(musicItem: IMusic.IMusicItem): Promise<string | null> {
        try {
            // 与取源/图标同一套「文件真值」判定：本地有这份音频才去找同名 .lrc。
            // 以前查的是下载记录，删掉记录后本地歌词就跟着认不出来了。
            await localSource.whenReady(LOCAL_LYRIC_READY_MS);
            const audioPath = localSource.getEntry(musicItem)?.path;
            if (!audioPath) return null;

            for (const lrcPath of this.localLyricCandidates(musicItem, audioPath)) {
                const exists = await fsUtil.isFile(lrcPath);
                if (!exists) continue;

                const content = await fsUtil.readFile(lrcPath);
                return typeof content === 'string'
                    ? content
                    : new TextDecoder().decode(content as unknown as ArrayBuffer);
            }
            return null;
        } catch {
            return null;
        }
    }

    /** 本地歌词文件的候选路径：歌曲同目录优先，其次配置的歌词目录 */
    private localLyricCandidates(musicItem: IMusic.IMusicItem, audioPath: string): string[] {
        const baseName = audioPath.replace(/\.[^.\\/]+$/, '');
        const fileName = baseName.split(/[\\/]/).pop() ?? '';
        if (!fileName) return [];

        const candidates = [`${baseName}.lrc`];
        const configuredDir = appConfig.getConfigByKey('download.lyricPath')?.trim();
        if (configuredDir) {
            const sep = configuredDir.includes('\\') ? '\\' : '/';
            candidates.push(
                `${configuredDir.replace(/[\\/]+$/, '')}${sep}${this.lyricFileName(musicItem) || fileName}.lrc`,
            );
        }
        return candidates;
    }

    async refreshLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        // 清除当前歌词状态，让 fetchLyric 重新加载
        this.parser = null;
        this.currentMusicKey = null;
        store.set(currentLyricAtom, null);
        await this.fetchLyric(musicItem);
    }
    /**
     * 无歌词时自动搜索并切换歌词源。
     *
     * 规则对标播放失败的「自动换插件」：
     *   - 逐插件串行搜索 + 取词（同一时刻只有一个请求，不会打爆主进程）
     *   - 每首歌只自动尝试一次，用户手动解除关联后不会被反复自动关联
     *   - 搜索期间切歌则放弃，结果不落到新歌上
     *
     * 开关：设置 → 歌词 → 无歌词时自动搜索（播放器歌词设置里也能改）
     */
    private async tryAutoSearchLyric(
        key: string,
        musicItem: IMusic.IMusicItem,
        generation: number,
    ): Promise<void> {
        if (this.autoSearchTried || this.isAutoSearching) return;
        if (appConfig.getConfigByKey('lyric.autoSearchLyric') === false) return;
        // 已经有一次更新的取词请求接管了（例如用户手动刷新）→ 不再自动换源
        if (this.fetchGeneration !== generation) return;

        const plugins = pluginManager.getSortedSearchablePlugins('lyric');
        if (!plugins.length) return;

        this.autoSearchTried = true;
        this.isAutoSearching = true;

        const query =
            `${musicItem.title ?? ''}${musicItem.artist ? ` ${musicItem.artist}` : ''}`.trim();
        if (!query) {
            this.isAutoSearching = false;
            return;
        }

        /** 结果还该不该落到界面上：歌没换 + 没有更新的取词请求 */
        const isStale = () => this.currentMusicKey !== key || this.fetchGeneration !== generation;

        try {
            const candidates = plugins.slice(0, AUTO_LYRIC_MAX_PLUGINS);
            for (const plugin of candidates) {
                // 用户已切歌 / 已手动选了别的歌词 → 放弃
                if (isStale()) return;

                const searchResult = await withTimeout(
                    pluginManager.callPluginMethod({
                        hash: plugin.hash,
                        method: 'search',
                        args: [query, 1, 'lyric'],
                    }),
                    AUTO_LYRIC_TIMEOUT_MS,
                );
                if (isStale()) return;

                const list = (searchResult?.data as ILyric.ILyricItem[] | undefined) ?? [];
                if (!list.length) continue;

                // 逐个候选取词，取到有内容的就用
                for (const lyricItem of list.slice(0, 2)) {
                    const lyricSource = await withTimeout(
                        pluginManager.callPluginMethod({
                            platform: lyricItem.platform,
                            method: 'getLyric',
                            args: [lyricItem],
                        }),
                        AUTO_LYRIC_TIMEOUT_MS,
                    );
                    if (isStale()) return;
                    if (!lyricSource?.rawLrc && !lyricSource?.translation) continue;

                    const rawLrc = lyricSource.rawLrc ?? lyricSource.translation;
                    const translation = lyricSource.rawLrc ? lyricSource.translation : undefined;

                    await mediaMeta.setMeta(
                        musicItem.platform,
                        String(musicItem.id),
                        {
                            associatedLyric: { musicItem: lyricItem, rawLrc, translation },
                        },
                        { title: musicItem.title, artist: musicItem.artist },
                    );
                    if (isStale()) return;

                    store.set(associatedLyricAtom, lyricItem);
                    showToast(
                        i18n.t('lyric.auto_search_success', { platform: lyricItem.platform }),
                    );
                    // 用新歌词重新解析（refreshLyric 会重置 parser 并重新 fetch）
                    await this.refreshLyric(musicItem);
                    return;
                }
            }
        } catch {
            // 自动换源失败静默处理，不影响正常播放
        } finally {
            this.isAutoSearching = false;
        }
    }
}

export default LyricManager;
