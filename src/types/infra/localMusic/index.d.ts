import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

/**
 *
 * 继承 IMusicItemSlim 的 7 个字段（platform, id, title, artist, album, duration, artwork），
 * 其中 `id` 对应 DB 列 `music_id`，在扫描时确定（v11 起**按作品键**解析，不再依赖下载记录）：
 * - 作品在库里出现过（media_meta / music_items 有同 work_key 的条目）→ 复用那个 platform/id
 * - 从来没出现过 → `本地` + md5(filePath)
 */
export interface ILocalMusicItem extends IMusicItemSlim {
    /** 文件绝对路径（DB 主键） */
    filePath: string;
    /** 所在文件夹路径 */
    folder: string;
    /** 文件大小（字节） */
    fileSize: number | null;
    /** 文件修改时间（ms timestamp） */
    fileMtime: number | null;
    /** 所属扫描文件夹 ID */
    scanFolderId: string;
    /** 入库时间 */
    createdAt: number;
    /** 下载记录的登记音质（没有记录时为 null = 未知） */
    quality?: IMusic.IQualityKey | null;
    /** 这份文件怎么进来的：App 下载 / 目录扫描 */
    source?: 'download' | 'scan' | null;
}

/**
 * 「本地有没有这个文件」的查询条件。
 *
 * 匹配顺序（渲染层 core/localSource 与主进程 localMusic.lookupFile 完全一致）：
 * 主键 → 原始身份 → 作品键 → 歌名+歌手 → （歌手未知时）歌名唯一兜底。
 */
export interface ILocalFileQuery {
    platform: string;
    id: string | number;
    originPlatform?: string;
    originId?: string;
    title?: string;
    artist?: string;
    /** 条目自带的本地路径（本地音乐条目会有）；只要文件真的在就算命中 */
    localPath?: string;
}

/** 文件真值命中结果 */
export interface ILocalFileLookup {
    /** 磁盘上的绝对路径（已校验存在） */
    path: string;
    /** 登记音质；null = 未知（例如纯扫描入库的文件） */
    quality: IMusic.IQualityKey | null;
}

/**
 * 文件真值查询函数（`localMusic.lookupFile` 的 DI 形态）。
 *
 * 主进程各模块（歌词取源 / 下载判定 / 传云端）统一注入它，
 * 不再各自去查下载记录 —— 记录只表达任务状态，不表达文件存在性。
 */
export type ILocalFileLookupFn = (query: ILocalFileQuery) => Promise<ILocalFileLookup | null>;

/** 扫描文件夹 */
export interface IScanFolder {
    id: string;
    folderPath: string;
    lastScanAt: number | null;
    createdAt: number;
}

/**
 * 本地歌词文件（扫描目录里的 .lrc）。
 *
 * `audioPath` 为空表示「孤儿歌词」——同目录下没有同名音频，
 * 只能靠用户在歌词搜索里手动关联。
 */
export interface ILocalLyricItem {
    /** 歌词文件绝对路径（DB 主键） */
    filePath: string;
    /** 不含扩展名的文件名（配对 / 搜索用） */
    fileName: string;
    /** 从文件名解析出的歌名 */
    title: string;
    /** 从文件名解析出的歌手 */
    artist: string;
    /** 同目录同名音频路径；null = 孤儿歌词 */
    audioPath: string | null;
    /** 所在文件夹路径 */
    folder: string;
    fileSize: number | null;
    fileMtime: number | null;
    scanFolderId: string;
    createdAt: number;
}

/** 扫描进度 */
export interface IScanProgress {
    phase: 'discovering' | 'diffing' | 'parsing' | 'done';
    scanned: number;
    total: number;
    current?: string;
}

/** 扫描结果摘要 */
export interface IScanResult {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    /** 本次扫描入库/更新的歌词文件数 */
    lyrics: number;
    elapsed: number;
}

/** 文件信息（扫描引擎产出） */
export interface IFileInfo {
    filePath: string;
    size: number;
    mtime: number;
}

/** 一次目录遍历的产出：音频 + 歌词 */
export interface IDiscoverResult {
    audios: IFileInfo[];
    lyrics: IFileInfo[];
}

/** 增量 diff 结果 */
export interface IDiffResult {
    added: IFileInfo[];
    changed: IFileInfo[];
    removed: string[];
    unchanged: number;
}
