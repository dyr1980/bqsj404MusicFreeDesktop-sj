/**
 * TrackPlayer 模块内部类型
 */
import type LyricParser from '@common/lyricParser';
import type { IParsedLrcItem } from '@common/lyricParser';

export interface ICurrentLyric {
    parser?: LyricParser;
    currentLrc?: IParsedLrcItem;
}

export interface IPlayOptions {
    restartOnSameMedia?: boolean;
}

/**
 * 实际音源的种类。
 *
 * - `loading`：已经切到这首歌、但音源还没取到 —— 状态条显示「获取音源中…」。
 *   必须有这个状态：否则切歌瞬间状态条还挂着**上一首**的音源，
 *   看起来就像「换了歌，音源信息还带过来」。
 */
export type SourceKind = 'local' | 'cloud' | 'plugin' | 'loading';

/**
 * 当前实际音源。
 *
 * 要和「歌曲条目的 platform」区分开：一首歌可能是在 A 插件搜到的（platform=A），
 * 但真正播的是本地已下载文件 / 云盘同名文件 —— 状态条要显示的是**实际音源**。
 */
export interface ICurrentSource {
    kind: SourceKind;
    /** kind === 'plugin' 时的插件平台名 */
    platform?: string;
    quality?: IMusic.IQualityKey;
}

/** 自动换源进度（非空 = 正在换源，或刚出结果） */
export interface ISourceSwitchState {
    /** 正在尝试的插件平台 */
    trying?: string;
    /** 已经试过的插件平台 */
    tried: string[];
    /** 参与换源的插件总数 */
    total: number;
    /** 结束后的结果，组件展示几秒后自行清掉 */
    result?: { ok: boolean; platform?: string; aborted?: boolean };
}
