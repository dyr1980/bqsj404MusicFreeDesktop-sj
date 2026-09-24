import type { IShortCutMap } from '@appTypes/infra/shortCut';
import type { ISize, IPoint } from '../windowDrag';

/** 可序列化的音频输出设备信息（替代不可序列化的 MediaDeviceInfo） */
export interface IAudioOutputDevice {
    deviceId: string;
    label: string;
    groupId: string;
}

interface _IAppConfig {
    '$schema-version': number;
    'normal.closeBehavior': 'exit_app' | 'minimize';
    'normal.maxHistoryLength': number;
    'normal.checkUpdate': boolean;
    'normal.taskbarThumb': 'window' | 'artwork';
    /**
     * 网络封面的自动加载策略。
     *
     * - all  : 歌单封面 + 歌曲封面都自动加载（默认）
     * - sheet: 只自动加载歌单封面
     * - song : 只自动加载歌曲封面
     * - none : 都不自动加载（界面显示内置默认封面图）
     *
     * 只影响「网络封面」：右键设置的本地封面、本地音乐内嵌封面不受影响。
     */
    'normal.autoLoadCover': 'all' | 'sheet' | 'song' | 'none';
    'normal.musicListHideColumns': Array<'duration' | 'platform'>;
    /** [win10+] 使用自定义原生托盘菜单 */
    'normal.useCustomTrayMenu': boolean;
    'normal.language': string;

    /** 歌单内搜索区分大小写 */
    'playMusic.caseSensitiveInSearch': boolean;
    /** 默认播放音质 */
    'playMusic.defaultQuality': IMusic.IQualityKey;
    /** 默认播放音质缺失时 */
    'playMusic.whenQualityMissing': 'higher' | 'lower' | 'skip';
    /** 双击音乐列表时 */
    'playMusic.clickMusicList': 'normal' | 'replace';
    /** 播放失败时：pause 暂停播放 / skip 跳到下一首 / toggle 自动换插件（无可用音源时回退为跳到下一首） */
    /**
     * 播放失败时的行为。
     *
     * - `toggle`：自动换源（**不**替换原歌单信息）—— 歌单里那条还是原来的来源，
     *   换源成功的来源只写进播放队列那次
     * - `toggle-replace`：自动换源 + **替换原歌单信息** —— 成功后把各歌单里这条
     *   改成真正播通的来源（命中本地就指向本地），下次播放直接按新来源取源
     */
    'playMusic.playError': 'pause' | 'skip' | 'toggle' | 'toggle-replace';
    /** 输出设备 */
    'playMusic.audioOutputDevice': IAudioOutputDevice | null;
    /** 设备变化时 */
    'playMusic.whenDeviceRemoved': 'pause' | 'play';

    /** [darwin only] 显示状态栏歌词 */
    'lyric.enableStatusBarLyric': boolean;
    /** 显示桌面歌词 */
    'lyric.enableDesktopLyric': boolean;
    /** 桌面歌词置顶 */
    'lyric.alwaysOnTop': boolean;
    /** 锁定桌面歌词 */
    'lyric.lockLyric': boolean;
    /** 字体 */
    'lyric.fontData': FontData;
    /** 字体颜色 */
    'lyric.fontColor': string;
    /** 字体大小 */
    'lyric.fontSize': number;
    /** 描边颜色 */
    'lyric.strokeColor': string;
    /** 无歌词时自动搜索并切换歌词源（对标播放失败的「自动换插件」） */
    'lyric.autoSearchLyric': boolean;

    /** 是否启用本地快捷键 */
    'shortCut.enableLocal': boolean;
    /** 是否启用全局快捷键 */
    'shortCut.enableGlobal': boolean;
    /** 快捷键映射 */
    'shortCut.shortcuts': IShortCutMap;

    /** 下载路径 */
    'download.path': string;
    /** 歌词下载路径（空 = 与歌曲文件同目录，文件名为 <歌名 - 歌手>.lrc） */
    'download.lyricPath': string;
    /** 默认下载音质 */
    'download.defaultQuality': IMusic.IQualityKey;
    /** 默认下载音质缺失时 */
    'download.whenQualityMissing': 'higher' | 'lower';
    /** 最多同时下载 */
    'download.concurrency': number;

    /** 是否自动升级插件 */
    'plugin.autoUpdatePlugin': boolean;
    /** 是否不检测插件版本 */
    'plugin.notCheckPluginVersion': boolean;

    /** 是否启用代理 */
    'network.proxy.enabled': boolean;
    'network.proxy.host': string;
    'network.proxy.port': string;
    'network.proxy.username': string;
    'network.proxy.password': string;

    /** 恢复歌单时行为 */
    'backup.resumeBehavior': 'append' | 'overwrite';
    /** 备份时同时把本地音乐文件（下载 + 本地库）上传到云盘 */
    'backup.uploadLocalFiles': boolean;
    /** 歌词也一起备份到云盘歌词目录（/MusicFree/lyrics） */
    'backup.uploadLyrics': boolean;
    /** 开启「自动备份」：本地新增/变化/删除后延迟对账同步到云盘 */
    'backup.autoBackup': boolean;
    /** 内部状态：有待同步的变更（时间戳，0 = 无） */
    'backup.syncPendingAt': number;
    /** 内部状态：上次自动同步完成时间（时间戳） */
    'backup.lastSyncAt': number;
    /** URL */
    'backup.webdav.url': string;
    /** 用户名 */
    'backup.webdav.username': string;
    /** 密码 */
    'backup.webdav.password': string;

    /** 本地音乐：扫描目录列表（由 scan_folders 表管理，此项已废弃） */
    'localMusic.watchDir': string[];
    /** 本地音乐：排除路径列表（绝对路径，子路径也会被排除） */
    'localMusic.excludedPaths': string[];
    /** 本地音乐：最短时长过滤（秒），低于此值的文件在渲染进程侧过滤 */
    'localMusic.minDurationSec': number;

    /** 不需要用户配置的数据 */
    'private.mainWindowSize': ISize;
    'private.lyricWindowPosition': IPoint;
    'private.lyricWindowSize': ISize;

    'private.minimodeWindowPosition': IPoint;

    /** 插件订阅源列表 */
    'private.pluginSubscription': Array<{ name: string; srcUrl: string }>;
}

type PartialOrNull<T> = { [P in keyof T]?: T[P] | null };
export type IAppConfig = PartialOrNull<_IAppConfig>;
export type IAppConfigKey = keyof IAppConfig;

export type ConfigSource = 'main' | 'renderer';

/**
 * appConfig 模块对外暴露的只读能力接口。
 *
 * 用于其他 infra 模块通过 setup 注入来消费配置，
 * 而无需直接 import appConfig 单例。
 * main 和 renderer 侧均使用此接口。
 */
export interface IAppConfigReader {
    getConfig(): IAppConfig;
    getConfigByKey<T extends keyof IAppConfig>(key: T): IAppConfig[T];
    onConfigUpdated(
        cb: (patch: IAppConfig, config: IAppConfig, source: ConfigSource) => void,
    ): void;
    offConfigUpdated(
        cb: (patch: IAppConfig, config: IAppConfig, source: ConfigSource) => void,
    ): void;
}
