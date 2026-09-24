/**
 * sourceMatch — 换源匹配规则（纯函数，无副作用/无跨模块状态）
 *
 * 参考落雪音乐（lx-music）的换源匹配策略：
 *   1. 歌名 + 歌手完全一致（归一化后比较，歌手排序后比较）
 *   2. 歌名完全一致 + 歌手互相包含
 *   3. 歌名互相包含 + 歌手互相包含
 *   4. 歌名互相包含（兜底）
 * 批量换源时额外用「时长接近（±5s）」在精确匹配集合中优选。
 *
 * 归一化：去除空白与常见标点（中英文），避免 "无期 (Live)" 与 "无期" 之类差异
 * 直接被判为不同歌曲。
 *
 * 本模块刻意不依赖 trackPlayer / musicSheet，避免循环依赖：
 * 播放器（自动换源）与 UI（手动换源）都只依赖这里。
 */

import pluginManager from '@infra/pluginManager/renderer';

/** 歌手分隔符（多歌手归一化排序用） */
const SINGERS_SPLIT_RXP = /、|&|;|；|\/|,|，|\|/;

/** 归一化时需要剔除的字符（空白 + 常见标点符号） */
const FILTER_RXP =
    /\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|_|<|>|\||\/|\]|\[|!|！|？|\?|:|：|·|・|【|】|《|》/g;

/** 时长容差（秒）——批量换源时优先选择时长接近的结果 */
const INTERVAL_TOLERANCE = 5;

/** 单次搜索请求的页大小 */
export const TOGGLE_SEARCH_PAGE_SIZE = 25;

/**
 * 换源搜索的并发上限。
 *
 * 插件方法在主进程沙箱中执行：同时向数十个插件发起搜索会让主进程长时间忙于
 * 网络与 JSON 解析，导致所有 IPC（进而整个界面）卡顿，也容易触发平台限流。
 * 因此无论是自动换源还是手动换源弹窗，都必须限制并发。
 */
export const TOGGLE_SEARCH_CONCURRENCY = 3;

/**
 * 单个插件的换源搜索超时（ms）。
 *
 * 实测个别插件单次搜索接近 20s；换源链是串行执行的，没有超时会让整条链
 * 被一个慢插件卡死，表现为「点了换源后长时间没反应」。
 */
export const TOGGLE_SEARCH_TIMEOUT_MS = 10_000;

/** 给 Promise 加上超时保护 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('toggle search timeout')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * 以受限并发执行异步映射，保持结果顺序与输入一致。
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!items.length) return [];
    const results = new Array<R>(items.length);
    const size = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;

    const workers = Array.from({ length: size }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await mapper(items[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * 歌曲组标识：歌名 + 歌手（归一化后）。
 * 换源后 id/platform 会变化，用它与歌手识别「还是同一首歌」。
 */
export function getSongGroupKey(item: IMusic.IMusicItemBase): string {
    return `${filterStr(item.title)}__${filterStr(sortSinger(item.artist))}`;
}

/** 归一化字符串：去空白与标点，统一小写 */
export function filterStr(input: unknown): string {
    const value = typeof input === 'string' ? input : String(input ?? '');
    return value.replace(FILTER_RXP, '').toLowerCase();
}

/** 归一化歌手串：多歌手按字典序排序后拼接，消除顺序差异 */
export function sortSinger(singer: string | undefined | null): string {
    const value = singer ?? '';
    if (!SINGERS_SPLIT_RXP.test(value)) return value;
    return value
        .split(SINGERS_SPLIT_RXP)
        .map((s) => s.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .join('、');
}

/** 解析时长：支持 "03:45" 字符串与秒数 */
export function parseIntervalSeconds(interval: string | number | null | undefined): number {
    if (interval == null) return 0;
    if (typeof interval === 'number') return Number.isFinite(interval) ? interval : 0;
    if (!interval.includes(':')) {
        const n = Number(interval);
        return Number.isFinite(n) ? n : 0;
    }
    let total = 0;
    let unit = 1;
    const parts = interval.split(':');
    while (parts.length) {
        total += (parseInt(parts.pop() as string, 10) || 0) * unit;
        unit *= 60;
    }
    return total;
}

/** 判断两个时长是否接近（±5s），任一时长缺失视为不接近 */
function isIntervalClose(
    a: string | number | null | undefined,
    b: string | number | null | undefined,
): boolean {
    const sa = parseIntervalSeconds(a);
    const sb = parseIntervalSeconds(b);
    if (!sa || !sb) return false;
    return Math.abs(sa - sb) <= INTERVAL_TOLERANCE;
}

/** 换源候选（某个插件下匹配到的歌曲） */
export interface ISourceCandidate {
    /** 目标插件 platform */
    platform: string;
    /** 匹配到的完整歌曲数据（含 qualities/url/raw 等插件返回字段） */
    item: IMusic.IMusicItem;
}

/**
 * 从单个插件的搜索结果中挑选最匹配的歌曲。
 *
 * @param target      待换源的原始歌曲（歌名 / 歌手 / 时长基准）
 * @param candidates  该插件的搜索结果
 * @param strictInterval 是否用「时长接近」在精确匹配集合中优选（批量换源开启）
 */
export function pickMatchMusic(
    target: IMusic.IMusicItemBase,
    candidates: IMusic.IMusicItem[] | undefined | null,
    strictInterval = false,
): IMusic.IMusicItem | null {
    if (!candidates?.length) return null;

    const fName = filterStr(target.title);
    const fSinger = filterStr(sortSinger(target.artist));
    if (!fName) return null;

    // ① 歌名 + 歌手完全一致
    let matches = candidates.filter(
        (item) => filterStr(item.title) === fName && filterStr(sortSinger(item.artist)) === fSinger,
    );
    if (matches.length) {
        if (strictInterval) {
            const closer = matches.filter((item) =>
                isIntervalClose(item.duration, target.duration),
            );
            if (closer.length) matches = closer;
        }
        return matches[0];
    }

    // ② 歌名完全一致 + 歌手互相包含
    matches = candidates.filter((item) => {
        const singer = filterStr(sortSinger(item.artist));
        return (
            filterStr(item.title) === fName &&
            !!fSinger &&
            (singer.includes(fSinger) || fSinger.includes(singer))
        );
    });
    if (matches.length) return matches[0];

    // ③ 歌名、歌手互相包含
    matches = candidates.filter((item) => {
        const name = filterStr(item.title);
        const singer = filterStr(sortSinger(item.artist));
        return (
            !!name &&
            (name.includes(fName) || fName.includes(name)) &&
            !!fSinger &&
            (singer.includes(fSinger) || fSinger.includes(singer))
        );
    });
    if (matches.length) return matches[0];

    // ④ 仅歌名互相包含（兜底）
    matches = candidates.filter((item) => {
        const name = filterStr(item.title);
        return !!name && (name.includes(fName) || fName.includes(name));
    });
    if (matches.length) return matches[0];

    return null;
}

/** 构造搜索关键词：歌名 + 歌手 */
export function buildSearchKeyword(target: IMusic.IMusicItemBase): string {
    return [target.title, target.artist]
        .filter((s) => !!s && String(s).trim())
        .join(' ')
        .trim();
}

/**
 * 获取可用于换源的插件列表（支持 search 且已启用，按插件顺序排序）。
 * @param enabledOnly 仅返回已启用插件（默认 true）
 */
export function getTogglePlugins(enabledOnly = true): IPlugin.IPluginDelegate[] {
    return pluginManager.getSortedSearchablePlugins('music', enabledOnly);
}

/**
 * 在指定插件中搜索并挑选最匹配的歌曲。
 *
 * @returns 匹配到的歌曲；未找到或请求失败返回 null
 */
export async function searchMatchInPlugin(
    plugin: IPlugin.IPluginDelegate,
    target: IMusic.IMusicItemBase,
    options?: { strictInterval?: boolean; timeoutMs?: number },
): Promise<IMusic.IMusicItem | null> {
    const keyword = buildSearchKeyword(target);
    if (!keyword) return null;

    try {
        const result = await withTimeout(
            pluginManager.callPluginMethod({
                hash: plugin.hash,
                method: 'search',
                args: [keyword, 1, 'music'],
            }),
            options?.timeoutMs ?? TOGGLE_SEARCH_TIMEOUT_MS,
        );
        const data = (result?.data ?? []) as IMusic.IMusicItem[];
        return pickMatchMusic(target, data, options?.strictInterval ?? false);
    } catch {
        return null;
    }
}

/**
 * 在所有可换源插件中搜索（受限并发，保持插件顺序），返回每个插件的最佳匹配。
 *
 * 注意：不要无限制地并行搜索所有插件——插件方法在主进程沙箱中执行，
 * 一次向数十个插件发起网络请求会占满主进程（IPC/UI 全部变慢），
 * 也容易触发各音乐平台的限流。
 *
 * @param target          待换源歌曲
 * @param options.skipPlatforms 需要跳过的插件 platform（如已尝试过的）
 * @param options.strictInterval 是否启用时长优选
 * @param options.concurrency 并发上限（默认 3）
 */
export async function searchMatchAcrossPlugins(
    target: IMusic.IMusicItemBase,
    options?: {
        skipPlatforms?: Iterable<string>;
        strictInterval?: boolean;
        enabledOnly?: boolean;
        concurrency?: number;
    },
): Promise<ISourceCandidate[]> {
    const skip = new Set(options?.skipPlatforms ?? []);
    const plugins = getTogglePlugins(options?.enabledOnly ?? true).filter(
        (p) => !skip.has(p.platform),
    );
    if (!plugins.length) return [];

    const results = await mapWithConcurrency(
        plugins,
        options?.concurrency ?? TOGGLE_SEARCH_CONCURRENCY,
        async (plugin) => {
            const item = await searchMatchInPlugin(plugin, target, {
                strictInterval: options?.strictInterval,
            });
            return item ? { platform: plugin.platform, item } : null;
        },
    );

    return results.filter((r): r is ISourceCandidate => r !== null);
}

/** 串行换源查找的结果 */
export interface INextSourceResult {
    /** 匹配到的音源（无匹配时为 null） */
    candidate: ISourceCandidate | null;
    /**
     * 本次实际搜索过的插件 platform（含未匹配到的）。
     * 调用方应把它并入「已尝试音源」，避免下次重复搜索同样的插件。
     */
    searchedPlatforms: string[];
}

/**
 * 按插件顺序「逐个」查找下一个可用音源（自动换源用）。
 *
 * 与 searchMatchAcrossPlugins 的区别：
 *   - 串行执行：同一时刻只有一个插件在搜索，避免请求风暴拖垮主进程
 *   - 命中即返回：语义上就是「插件列表中的下一个插件」
 *   - 返回 searchedPlatforms，便于调用方累计已尝试音源
 */
export async function findNextSourceSequential(
    target: IMusic.IMusicItemBase,
    triedPlatforms: Iterable<string>,
    options?: {
        strictInterval?: boolean;
        enabledOnly?: boolean;
        /** 本次最多搜索多少个插件（默认不限制，直到插件列表走完） */
        maxAttempts?: number;
    },
): Promise<INextSourceResult> {
    const tried = new Set(triedPlatforms);
    const plugins = getTogglePlugins(options?.enabledOnly ?? true);
    const maxAttempts = options?.maxAttempts ?? Number.POSITIVE_INFINITY;

    const searchedPlatforms: string[] = [];
    let attempts = 0;

    for (const plugin of plugins) {
        if (tried.has(plugin.platform)) continue;
        if (attempts >= maxAttempts) break;
        attempts++;
        searchedPlatforms.push(plugin.platform);

        const item = await searchMatchInPlugin(plugin, target, {
            strictInterval: options?.strictInterval,
        });
        if (item) {
            return { candidate: { platform: plugin.platform, item }, searchedPlatforms };
        }
    }

    return { candidate: null, searchedPlatforms };
}
