/**
 * cloudDisk — 类型定义
 *
 * 云盘（WebDAV）音乐库：列出远端音频文件、生成可播放的本地转发地址。
 */

/** 云盘上的一个文件 */
export interface ICloudFile {
    /** 远端绝对路径，例如 /MusicFree/music/周杰伦 - 晴天.flac */
    path: string;
    /** 文件名（含扩展名） */
    name: string;
    /** 字节数 */
    size: number;
    /** 修改时间（ms 时间戳；取不到为 null） */
    mtime: number | null;
    /** 扩展名（小写，含点） */
    ext: string;
}

/** 云盘歌词目录里的一个 .lrc 文件 */
export interface ICloudLyricFile {
    /** 文件名（含 .lrc） */
    name: string;
    /** 远端绝对路径 */
    remotePath: string;
    /** 从文件名解析出的歌名 */
    title: string;
    /** 从文件名解析出的歌手 */
    artist: string;
    /** 字节数 */
    size: number;
}

/** 云盘连接状态 */
export interface ICloudStatus {
    /** 「设置 → 备份」里是否已填好 WebDAV 地址 / 账号 / 密码 */
    configured: boolean;
    /** 最近一次请求是否成功；null = 本次启动还没请求过 */
    connected: boolean | null;
    /** 远端音乐目录 */
    musicDir: string;
    /** 最近一次错误信息 */
    error?: string;
}

/** 云盘上传结果 */
export interface ICloudUploadResult {
    /** 成功上传的文件数 */
    uploaded: number;
    /** 跳过（远端已存在且大小一致）的文件数 */
    skipped: number;
    /** 失败的文件数 */
    failed: number;
    /** 逐条失败原因 */
    errors: string[];
}

/** 从云盘下载到本地的任务 */
export interface ICloudDownloadTask {
    /** 远端路径 */
    remotePath: string;
    /** 原歌曲平台（用于写下载记录，让本地优先取源命中） */
    platform: string;
    /** 原歌曲 id */
    musicId: string;
    /** 歌曲标题（决定本地文件名） */
    title: string;
    /** 歌手 */
    artist: string;
}

/** 下载到本地的结果 */
export interface ICloudDownloadResult {
    /** 实际下载数 */
    downloaded: number;
    /** 本地已有同大小文件而跳过 */
    skipped: number;
    /** 失败数 */
    failed: number;
    /** 一并恢复的歌词文件数（勾了「同时恢复歌词」时才有） */
    lyrics: number;
    /** 失败明细 */
    errors: string[];
}

/** 「从云盘下载到本地」的可选项 */
export interface ICloudDownloadOptions {
    /** 同时把 /MusicFree/lyrics 里的同名歌词恢复到本地 */
    withLyrics?: boolean;
}

/** 上传任务（由渲染层解析出本地文件路径后提交） */
export interface ICloudUploadTask {
    /**
     * 本地文件绝对路径。
     *
     * 留空表示「这首歌本地没有文件」——主进程会自己向插件取音源，**边下边传**，
     * 不落本地磁盘（见 cloudDisk.uploadFromSource）。
     */
    filePath?: string;
    /** 歌曲标题（用于远端文件名） */
    title: string;
    /** 歌手（用于远端文件名） */
    artist: string;
    /** 来源平台（取源 + 记录用） */
    platform?: string;
    /** 来源 id（取源 + 记录用） */
    id?: string;
}

/** 上传进度（广播） */
export interface ICloudUploadProgress {
    /** 已处理数量 */
    current: number;
    /** 总数 */
    total: number;
    /** 当前文件名 */
    name: string;
}

/** 上传来源：手动（右键传至云盘）/ 自动（备份或自动同步） */
export type ICloudUploadSource = 'manual' | 'auto';

/** 云盘上传清单记录 */
export interface ICloudUploadRecord {
    platform: string;
    musicId: string;
    title: string;
    artist: string;
    remotePath: string;
    localPath?: string;
    source: ICloudUploadSource;
    size?: number;
    uploadedAt: number;
    /**
     * 作品键（归一化 歌名|歌手）。
     *
     * 「云端有没有这首」按它判断，不按插件身份 —— 同一首歌换个插件播/下载，
     * 不该被当成「没传过」或者「本地已删除」的孤儿。
     */
    workKey?: string | null;
}

/**
 * 上传清单的记录身份（清单主键 = platform + musicId + remotePath）。
 *
 * 只删清单记录（云端文件保留）时要精确到三元组：同一首歌换个插件再传会命中
 * 同一个远端文件、写出两条记录，只按 remotePath 删会把另一条身份一起带走。
 */
export interface ICloudUploadIdentity {
    platform: string;
    musicId: string;
    remotePath: string;
}
