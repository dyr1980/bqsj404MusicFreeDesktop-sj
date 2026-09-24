/**
 * 全局通用常量
 */

/** 音质键名，从低到高排列 */
export const QUALITY_KEYS: IMusic.IQualityKey[] = ['low', 'standard', 'high', 'super'];

/** 播放器状态 */
export enum PlayerState {
    /** 无音频 */
    None,
    /** 播放中 */
    Playing,
    /** 暂停 */
    Paused,
    /** 缓冲中 */
    Buffering,
}

/** 播放模式 */
export enum RepeatMode {
    /** 随机 */
    Shuffle = 'shuffle',
    /** 播放队列 */
    Queue = 'queue-repeat',
    /** 单曲循环 */
    Loop = 'loop',
}

/** RepeatMode 循环切换顺序：Queue → Shuffle → Loop → Queue */
export const REPEAT_MODE_NEXT: Record<RepeatMode, RepeatMode> = {
    [RepeatMode.Queue]: RepeatMode.Shuffle,
    [RepeatMode.Shuffle]: RepeatMode.Loop,
    [RepeatMode.Loop]: RepeatMode.Queue,
};

/** 日志级别 */
export enum LogLevel {
    Debug = 'debug',
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

// 主进程的Resource
export enum ResourceName {
    SKIP_LEFT_ICO = 'skip-left.ico',
    SKIP_RIGHT_ICO = 'skip-right.ico',
    PAUSE_ICO = 'pause.ico',
    PLAY_ICO = 'play.ico',
    LOGO_ICO = 'logo.ico',
    /**
     * 默认封面（墨笔谱号），与渲染进程共用同一份素材（见 renderer/common/DefaultCover）。
     *
     * 注意：这张图是 **alpha mask**（只有墨迹形状、RGB 全黑、底色透明），
     * 渲染进程用 currentColor 染色；主进程必须先用
     * `@main/core/coverBitmap` 合成成不透明底图再交给原生模块，否则深色菜单上
     * 只剩一片透明 + 看不见的黑墨。
     */
    DEFAULT_COVER_IMAGE = 'default-cover.png',
    LOGO_IMAGE = 'logo.png',
}

/**
 * RequestStatus — 通用请求/加载状态枚举
 *
 * 用于网络请求、页面加载、分页等所有涉及异步状态的场景。
 * 所有 UI 组件（StatusPlaceholder、ListFooter 等）统一消费此枚举。
 */
export enum RequestStatus {
    /** 初始态，尚未发起请求 */
    Idle = 'idle',
    /** 请求中 */
    Pending = 'pending',
    /** 请求成功完成 */
    Done = 'done',
    /** 请求失败 */
    Error = 'error',
}

/** 播放错误原因 */
export enum ErrorReason {
    /** 空资源（无 URL） */
    EmptyResource,
    /** 不支持的资源格式 */
    UnsupportedResource,
    /** 恢复播放失败（启动时） */
    HydrationFailed,
}

/** 标记 slim 对象的内部 key（值为 '$slim'） */
export const INTERNAL_SLIM_KEY = '$slim';

/** 支持的音频文件扩展名（小写，含点号） */
export const SUPPORTED_AUDIO_EXTS = new Set([
    '.mp3',
    '.mp4',
    '.m4s',
    '.m4a',
    '.flac',
    '.wav',
    '.ogg',
    '.aac',
    '.wma',
    '.ape',
    '.opus',
]);

/** 支持的歌词文件扩展名（小写，含点号） */
export const SUPPORTED_LYRIC_EXTS = new Set(['.lrc']);

/** 歌词翻译文件的后缀（`<歌名 - 歌手>-tr.lrc`） */
export const LYRIC_TRANSLATION_SUFFIX = '-tr';

/** 本地插件平台名 */
export const LOCAL_PLUGIN_NAME = '本地';

/** 本地插件哈希 */
export const LOCAL_PLUGIN_HASH = '本地';

/** 云盘插件平台名 */
export const CLOUD_PLUGIN_NAME = '云盘';

/** 云盘插件哈希 */
export const CLOUD_PLUGIN_HASH = '云盘';

/**
 * 内建插件的 hash 集合。
 *
 * 「本地」「云盘」并不是真正的外部插件，而是把应用内部能力（本地文件 / WebDAV 云端文件）
 * 包装成插件形态，好让取源统一走插件那条路。它们没有磁盘文件、也没有可配置项：
 *   - 开关不影响取源（取源查找不过滤启用状态）
 *   - 两者都不实现 search，所以也不会出现在搜索/换源候选里
 *   - 「卸载」不会删任何文件，且重启应用会自动重新注册
 * 因此**不在插件管理页展示**（避免误操作与困惑）。
 *
 * 以后再加内建插件时，往这里加一项即可（插件管理页的计数与列表都按它过滤）。
 */
export const BUILTIN_PLUGIN_HASHES: readonly string[] = [LOCAL_PLUGIN_HASH, CLOUD_PLUGIN_HASH];
