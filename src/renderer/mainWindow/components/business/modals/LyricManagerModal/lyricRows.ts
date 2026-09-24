/**
 * lyricRows — 「歌词管理」弹窗的行模型
 *
 * 每个页面各有一份「文件/记录」清单，这里把它们拉平成同一种行：
 *   本地音乐   → 本地音乐库里的歌（有本地音频文件）
 *   云端音乐   → 云盘 /MusicFree/music 里的歌
 *   下载管理   → 下载记录 + 已传云端清单（同一首歌只出一行）
 *
 * 一行最多挂三种歌词线索，和播放时的取源链口径一致（getLyricAdapter）：
 *   `linkedText/linked`  手动关联（mediaMeta.associatedLyric）—— 播放时第一优先
 *   `localLyricPath`     本地同名 .lrc（扫描到的，或按「音频同名 .lrc」推算后 stat 确认）
 *   `cloudLyric`         云端 /MusicFree/lyrics 里按作品键匹配到的那份
 *
 * ⚠️ 这里只做「文件和记录」的管理，不碰播放时的歌词偏移 / 显示 /
 * 桌面歌词（那些走 lyricManager，本模块一行都不动）。
 */

import { compositeKey } from '@common/mediaKey';
import { buildMediaNameKey } from '@common/mediaNameKey';
import type { ICloudLyricFile, ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import type { ILocalLyricItem } from '@appTypes/infra/localMusic';
import type { IMediaMeta } from '@appTypes/infra/mediaMeta';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

/** 管理范围（对应三个页面） */
export type TLyricScope = 'local' | 'cloud' | 'download';

/** 行里的歌曲条目（完整/精简都行） */
export type TLyricRowItem = IMusic.IMusicItem | IMusicItemSlim;

export interface ILyricRow {
    /** 唯一 key（platform+id） */
    key: string;
    title: string;
    artist: string;
    /** 歌曲条目（关联 / 播放 / 作品键用） */
    item: TLyricRowItem;
    /** 本地音频文件路径（决定同名 .lrc 落在哪；没有 = 这首歌本地没文件） */
    localAudioPath?: string;
    /** 本地歌词文件路径 */
    localLyricPath?: string;
    /** 云端歌词文件 */
    cloudLyric?: ICloudLyricFile;
    /** 是否已手动关联 */
    linked: boolean;
    /** 关联的歌词文本（没缓存文本时为空） */
    linkedText?: string;
    /** 关联来源的可读描述（歌名 - 歌手 @ 平台） */
    linkedFrom?: string;
}

/** 云盘/歌词文件都按「歌名 - 歌手」命名，这里生成同一套主干 */
export function lyricBaseName(title: string, artist: string): string {
    const name = (title ?? '').trim();
    const who = (artist ?? '').trim();
    if (!name) return who;
    return who ? `${name} - ${who}` : name;
}

/** 音频路径 → 同名 .lrc 路径（与 getLyricAdapter 的查找规则一致） */
export function expectedLyricPath(audioPath: string): string {
    const slash = Math.max(audioPath.lastIndexOf('/'), audioPath.lastIndexOf('\\'));
    const dot = audioPath.lastIndexOf('.');
    const base = dot > slash ? audioPath.slice(0, dot) : audioPath;
    return `${base}.lrc`;
}

/** 这一行有没有任何一份歌词 */
export function rowHasLyric(row: ILyricRow): boolean {
    return !!(row.linked || row.localLyricPath || row.cloudLyric);
}

/** 关键词匹配：空格分隔的每个词都要命中 */
export function matchTokens(haystack: string, query: string): boolean {
    if (!query) return true;
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = haystack.toLowerCase();
    return tokens.every((token) => hay.includes(token));
}

/** 关键词匹配：空格分隔的每个词都要命中（歌名 / 歌手 / 文件名 / 路径） */
export function matchLyricRow(row: ILyricRow, query: string): boolean {
    return matchTokens(
        [row.title, row.artist, row.localAudioPath, row.localLyricPath, row.cloudLyric?.name]
            .filter(Boolean)
            .join('\n'),
        query,
    );
}

// ────────────────────────────────────────────────────────────────────────────
// 列表条目模型
//
// 未匹配的歌词（本地找不到同名音频 / 云端找不到对应歌曲）不再单独一个小区块，
// 而是并入**同一个列表**的一类条目：这样它们天然吃到搜索、多选、虚拟滚动，
// 并且能按来源分组（本地歌词 / 云端歌词）显示。
// ────────────────────────────────────────────────────────────────────────────

/** 顶部筛选项 */
export type TLyricFilter = 'all' | 'has' | 'none' | 'orphan';

/** 未匹配歌词的来源 */
export type TLyricOrphanSource = 'local' | 'cloud';

/** 可选中的条目（歌曲行 / 未匹配歌词行） */
export type TLyricSelectableEntry =
    | { kind: 'song'; key: string; row: ILyricRow; selectIndex: number }
    | {
          kind: 'orphan';
          key: string;
          source: 'local';
          lyric: ILocalLyricItem;
          selectIndex: number;
      }
    | {
          kind: 'orphan';
          key: string;
          source: 'cloud';
          file: ICloudLyricFile;
          selectIndex: number;
      };

/** 列表条目：可选中的行 + 未匹配区的分组标题 */
export type TLyricEntry =
    | TLyricSelectableEntry
    | { kind: 'group'; key: string; source: TLyricOrphanSource; count: number };

export interface ILyricEntryCounts {
    all: number;
    has: number;
    none: number;
    orphan: number;
}

export interface IBuildLyricEntriesInput {
    rows: readonly ILyricRow[];
    /** 本地未匹配歌词（扫描器已判定「同目录没有同名音频」） */
    orphanLocal: readonly ILocalLyricItem[];
    /** 云端未匹配歌词（当前已知的所有歌曲里都找不到同名作品） */
    orphanCloud: readonly ICloudLyricFile[];
    filter: TLyricFilter;
    keyword: string;
}

export interface IBuildLyricEntriesResult {
    entries: TLyricEntry[];
    /** 全部可选中条目（顺序 = Shift 连选范围，`selectIndex` 就是它的下标） */
    selectables: TLyricSelectableEntry[];
    counts: ILyricEntryCounts;
}

/** 未匹配歌词的关键词匹配（按文件名 / 歌名 / 歌手） */
function matchOrphan(parts: Array<string | undefined>, query: string): boolean {
    return matchTokens(parts.filter(Boolean).join('\n'), query);
}

/**
 * 组装列表条目。
 *
 * `all` / `has` / `none` 决定歌曲行的范围，`orphan` 只看未匹配歌词；
 * `all` 会把未匹配歌词按来源分组接在歌曲后面（数量不多，放最后不打断主列表）。
 * 计数是**总数**（不受关键词影响），和下载管理的状态计数口径一致。
 */
export function buildLyricEntries({
    rows,
    orphanLocal,
    orphanCloud,
    filter,
    keyword,
}: IBuildLyricEntriesInput): IBuildLyricEntriesResult {
    const withLyric = rows.filter(rowHasLyric).length;
    const counts: ILyricEntryCounts = {
        all: rows.length + orphanLocal.length + orphanCloud.length,
        has: withLyric,
        none: rows.length - withLyric,
        orphan: orphanLocal.length + orphanCloud.length,
    };

    const entries: TLyricEntry[] = [];
    const selectables: TLyricSelectableEntry[] = [];

    const pushSong = (row: ILyricRow) => {
        const entry: TLyricSelectableEntry = {
            kind: 'song',
            key: row.key,
            row,
            selectIndex: selectables.length,
        };
        selectables.push(entry);
        entries.push(entry);
    };

    const pushOrphanLocal = (lyric: ILocalLyricItem) => {
        const entry: TLyricSelectableEntry = {
            kind: 'orphan',
            key: `orphan:local:${lyric.filePath}`,
            source: 'local',
            lyric,
            selectIndex: selectables.length,
        };
        selectables.push(entry);
        entries.push(entry);
    };

    const pushOrphanCloud = (file: ICloudLyricFile) => {
        const entry: TLyricSelectableEntry = {
            kind: 'orphan',
            key: `orphan:cloud:${file.remotePath}`,
            source: 'cloud',
            file,
            selectIndex: selectables.length,
        };
        selectables.push(entry);
        entries.push(entry);
    };

    const showSongs = filter === 'all' || filter === 'has' || filter === 'none';
    const showOrphans = filter === 'all' || filter === 'orphan';

    if (showSongs) {
        for (const row of rows) {
            if (filter === 'has' && !rowHasLyric(row)) continue;
            if (filter === 'none' && rowHasLyric(row)) continue;
            if (!matchLyricRow(row, keyword)) continue;
            pushSong(row);
        }
    }

    if (showOrphans) {
        // 未匹配区按**名称排序**，同来源聚在一起（云端列表本身就是按名排的，本地这里补上）
        const localHits = [...orphanLocal]
            .filter((lyric) => matchOrphan([lyric.fileName, lyric.filePath], keyword))
            .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh'));
        if (localHits.length) {
            entries.push({
                kind: 'group',
                key: 'group:local',
                source: 'local',
                count: localHits.length,
            });
            for (const lyric of localHits) pushOrphanLocal(lyric);
        }

        const cloudHits = [...orphanCloud]
            .filter((file) => matchOrphan([file.name, file.title, file.artist], keyword))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        if (cloudHits.length) {
            entries.push({
                kind: 'group',
                key: 'group:cloud',
                source: 'cloud',
                count: cloudHits.length,
            });
            for (const file of cloudHits) pushOrphanCloud(file);
        }
    }

    return { entries, selectables, counts };
}

export interface IBuildLyricRowsInput {
    scope: TLyricScope;
    /** 候选歌曲（local：本地音乐库；cloud：云盘条目；download：下载记录 + 上传清单） */
    items: ReadonlyArray<TLyricRowItem>;
    /** 本地扫描到的 .lrc（含孤儿：audioPath 为空） */
    localLyrics: readonly ILocalLyricItem[];
    /** 云端歌词目录里的 .lrc */
    cloudLyrics: readonly ICloudLyricFile[];
    /** 经 fs 校验确实存在的本地 .lrc 路径（扫描目录之外的歌靠它） */
    existingLyricPaths: ReadonlySet<string>;
    /** 这首歌在本地有没有文件（core/localSource，以文件系统为准） */
    resolveLocalPath: (item: TLyricRowItem) => string | undefined;
    /** 读 mediaMeta（提前 preload 过，这里同步取） */
    metaOf: (platform: string, id: string) => IMediaMeta | null;
}

/** 组装行（同一首歌只出一行；云端清单里同一文件的多条身份会合并） */
export function buildLyricRows({
    scope,
    items,
    localLyrics,
    cloudLyrics,
    existingLyricPaths,
    resolveLocalPath,
    metaOf,
}: IBuildLyricRowsInput): ILyricRow[] {
    const lyricByAudio = new Map<string, ILocalLyricItem>();
    for (const lyric of localLyrics) {
        if (lyric.audioPath) lyricByAudio.set(lyric.audioPath, lyric);
    }

    const cloudByWorkKey = new Map<string, ICloudLyricFile>();
    for (const file of cloudLyrics) {
        const workKey = buildMediaNameKey(file.title, file.artist);
        if (workKey && !cloudByWorkKey.has(workKey)) cloudByWorkKey.set(workKey, file);
    }

    const rows: ILyricRow[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        if (!item) continue;
        const platform = item.platform;
        const id = String(item.id);
        const key = compositeKey(platform, id);
        if (seen.has(key)) continue;
        seen.add(key);

        const title = item.title ?? '';
        const artist = item.artist ?? '';

        // 本地音频：条目自带 localPath（本地音乐库）或按文件系统查（下载/云端条目）
        const itemLocalPath =
            typeof (item as IMusic.IMusicItem).localPath === 'string'
                ? (item as IMusic.IMusicItem).localPath
                : undefined;
        const localAudioPath = itemLocalPath || resolveLocalPath(item) || undefined;

        let localLyricPath: string | undefined;
        if (localAudioPath) {
            const scanned = lyricByAudio.get(localAudioPath);
            if (scanned) localLyricPath = scanned.filePath;
            else {
                const expected = expectedLyricPath(localAudioPath);
                if (existingLyricPaths.has(expected)) localLyricPath = expected;
            }
        }

        const meta = metaOf(platform, id);
        const associated = meta?.associatedLyric;
        const linkedItem = associated?.musicItem;

        rows.push({
            key: `${scope}:${key}`,
            title,
            artist,
            item,
            localAudioPath,
            localLyricPath,
            cloudLyric: cloudByWorkKey.get(buildMediaNameKey(title, artist)),
            linked: !!associated,
            linkedText: associated?.rawLrc || undefined,
            linkedFrom: associated
                ? [linkedItem?.title ?? title, linkedItem?.artist ?? artist]
                      .filter(Boolean)
                      .join(' - ') + (linkedItem?.platform ? ` @ ${linkedItem.platform}` : '')
                : undefined,
        });
    }

    return rows;
}

/** 下载管理的候选：下载记录（有本地文件）+ 已传云端清单（有云端文件） */
export function downloadCandidates(input: {
    downloaded: ReadonlyArray<{
        platform: string;
        musicId: string;
        title?: string;
        artist?: string;
    }>;
    uploads: readonly ICloudUploadRecord[];
}): TLyricRowItem[] {
    const items: TLyricRowItem[] = [];
    for (const record of input.downloaded) {
        items.push({
            platform: record.platform,
            id: String(record.musicId),
            title: record.title ?? '',
            artist: record.artist ?? '',
        });
    }
    for (const record of input.uploads) {
        items.push({
            platform: record.platform,
            id: String(record.musicId),
            title: record.title ?? '',
            artist: record.artist ?? '',
        });
    }
    return items;
}
