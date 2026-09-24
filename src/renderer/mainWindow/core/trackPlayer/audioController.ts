/**
 * AudioController — IAudioController 接口 + WebAudioController 实现
 *
 * 底层音频播放抽象，面向接口编程。
 * 当前实现：WebAudioController（HTMLAudioElement + HLS）
 * 未来扩展：MpvAudioController 等
 */
import EventEmitter from 'eventemitter3';
import Hls from 'hls.js';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { PlayerState, ErrorReason } from '@common/constant';
import requestForwarder from '@infra/requestForwarder/renderer';
import { isCoverAutoLoadEnabled } from '@renderer/common/coverLoad';
import { getCachedDefaultCover, getDefaultCoverDataUrl } from '@renderer/common/defaultCoverImage';

// ─── 事件类型 ───

export interface IAudioControllerEvents {
    /** 播放状态变化 */
    stateChange: (state: PlayerState) => void;
    /** 播放进度更新 */
    timeUpdate: (progress: { currentTime: number; duration: number }) => void;
    /** 播放结束 */
    ended: () => void;
    /** 播放错误 */
    error: (reason: ErrorReason, detail?: any) => void;
    /** 音量变化 */
    volumeChange: (volume: number) => void;
    /** 速度变化 */
    speedChange: (speed: number) => void;
}

// ─── 接口定义 ───

/** 音频控制器接口 — 所有实现必须遵守 */
export interface IAudioController extends EventEmitter<IAudioControllerEvents> {
    /** 预准备（设置 MediaSession metadata，清空旧音源） */
    prepareTrack(musicItem: IMusicItemSlim): void;
    /** 设置音源并可选自动播放 */
    setTrackSource(source: IPlugin.IMediaSourceResult, musicItem: IMusic.IMusicItem): void;
    play(): void;
    pause(): void;
    seekTo(seconds: number): void;
    reset(): void;
    destroy(): void;

    setVolume(volume: number): void;
    setSpeed(speed: number): void;
    setSinkId(deviceId: string): Promise<void>;

    readonly playerState: PlayerState;
    readonly hasSource: boolean;
}

// ─── WebAudioController 实现 ───

class WebAudioController extends EventEmitter<IAudioControllerEvents> implements IAudioController {
    private audio: HTMLAudioElement;
    private hls: Hls | null = null;
    private _playerState: PlayerState = PlayerState.None;
    private _sourceId = 0; // fetch 竞态守卫
    private _currentBlobUrl: string | null = null; // 追踪 blob URL 防止内存泄漏

    /**
     * MediaSession 元数据的世代号。
     *
     * 默认封面是异步（canvas）合成的：合成完可能已经切歌/停止了，
     * 靠它判断"还该不该把这张图补上去"，避免把上一首的封面盖到新歌上。
     */
    private _mediaSessionToken = 0;

    get playerState(): PlayerState {
        return this._playerState;
    }

    get hasSource(): boolean {
        return !!this.audio.src && this.audio.src !== location.href;
    }

    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.audio.controls = false;
        this.bindEvents();
    }

    prepareTrack(musicItem: IMusicItemSlim): void {
        const token = ++this._mediaSessionToken;
        const artwork = this.resolveMediaSessionArtwork(musicItem.artwork);

        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album ?? undefined,
            artwork: artwork ? [{ src: artwork }] : undefined,
        });

        // 默认封面是 canvas 异步合成的：这一拍还没合成好就先不带图，合成完再补一次。
        // token 保证期间没切歌/停止，否则不补。
        if (!artwork) {
            void getDefaultCoverDataUrl()
                .then((url) => {
                    if (token !== this._mediaSessionToken || !url) return;
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title: musicItem.title,
                        artist: musicItem.artist,
                        album: musicItem.album ?? undefined,
                        artwork: [{ src: url }],
                    });
                })
                .catch(() => {
                    // 合成失败只是少一张缩略图，不影响播放
                });
        }

        this.setPlayerState(PlayerState.None);
        this.audio.src = '';
        this.audio.removeAttribute('src');
        navigator.mediaSession.playbackState = 'none';
    }

    setTrackSource(source: IPlugin.IMediaSourceResult, _musicItem: IMusic.IMusicItem): void {
        this.destroyHls();
        this.revokeBlobUrl();
        const sourceId = ++this._sourceId;

        // 从 URL 的 userinfo 部分提取 Basic Auth（如 http://user:pass@host/...）
        const { cleanUrl: url, authHeader } = this.extractBasicAuth(source.url!);
        let headers = this.buildHeaders(source);
        if (authHeader) {
            if (!headers) headers = {};
            headers['Authorization'] = authHeader;
        }

        // HLS 支持
        if (this.isHls(source.url!)) {
            if (Hls.isSupported()) {
                this.initHls();
                if (headers) {
                    // HLS 自定义 header 通过 xhrSetup
                    this.hls!.config.xhrSetup = (xhr: XMLHttpRequest) => {
                        for (const [key, value] of Object.entries(headers)) {
                            xhr.setRequestHeader(key, value);
                        }
                    };
                }
                this.hls!.loadSource(url);
            } else {
                this.emit('error', ErrorReason.UnsupportedResource);
            }
            return;
        }

        // 带 header 的非 HLS：通过代理服务器
        if (headers) {
            const proxyUrl = requestForwarder.buildProxyUrl(url, headers);
            if (proxyUrl !== url) {
                // 代理可用，直接设置代理 URL
                this.audio.src = proxyUrl;
                return;
            }
            // 代理不可用，降级到 fetch
            fetch(url, { method: 'GET', headers })
                .then((res) => res.blob())
                .then((blob) => {
                    // 竞态守卫：fetch 期间可能已切歌
                    if (this._sourceId !== sourceId) return;
                    this._currentBlobUrl = URL.createObjectURL(blob);
                    this.audio.src = this._currentBlobUrl;
                })
                .catch((err) => {
                    if (this._sourceId !== sourceId) return;
                    this.emit('error', ErrorReason.EmptyResource, err);
                });
            return;
        }

        this.audio.src = url;
    }

    play(): void {
        if (this.hasSource) {
            this.audio.play().catch(() => {});
        }
    }

    pause(): void {
        if (this.hasSource) {
            this.audio.pause();
        }
    }

    seekTo(seconds: number): void {
        if (this.hasSource && isFinite(seconds)) {
            this.audio.currentTime = Math.min(seconds, this.audio.duration || Infinity);
        }
    }

    setVolume(volume: number): void {
        this.audio.volume = Math.max(0, Math.min(1, volume));
    }

    setSpeed(speed: number): void {
        this.audio.defaultPlaybackRate = speed;
        this.audio.playbackRate = speed;
    }

    setSinkId(deviceId: string): Promise<void> {
        return (this.audio as any).setSinkId(deviceId);
    }

    reset(): void {
        this.setPlayerState(PlayerState.None);
        this.revokeBlobUrl();
        this.audio.src = '';
        this.audio.removeAttribute('src');
        // 让在途的「默认封面补图」作废，避免停止播放后又被补上 metadata
        this._mediaSessionToken++;
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }

    destroy(): void {
        this.destroyHls();
        this.reset();
        this.removeAllListeners();
    }

    // ─── Private Methods ───

    /**
     * 决定系统媒体控件（Windows 音量浮层里的媒体卡片 / SMTC）用哪张缩略图：
     *
     *   - 条目没有封面 → **默认封面**（与播放器界面显示的一致，而不是留空）
     *   - 封面是网络图（http/https）→ 受「设置 → 常规 → 封面加载」约束；
     *     被关掉时同样退回默认封面（与托盘 / 任务栏缩略图的做法一致，不为一张缩略图偷偷下封面）
     *   - 本地数据（data: / file:，含右键「更换封面」设的本地图、本地文件内嵌封面）
     *     → 始终使用，不受该开关影响
     */
    private resolveMediaSessionArtwork(raw?: string | null): string | null {
        const artwork = (raw ?? '').trim();
        if (artwork) {
            const isNetworkArtwork = /^https?:\/\//i.test(artwork);
            if (!isNetworkArtwork || isCoverAutoLoadEnabled('song')) return artwork;
        }
        return getCachedDefaultCover();
    }

    private bindEvents(): void {
        this.audio.onplaying = () => {
            this.setPlayerState(PlayerState.Playing);
            navigator.mediaSession.playbackState = 'playing';
        };

        this.audio.onpause = () => {
            this.setPlayerState(PlayerState.Paused);
            navigator.mediaSession.playbackState = 'paused';
        };

        this.audio.onerror = (event) => {
            this.setPlayerState(PlayerState.Paused);
            this.emit('error', ErrorReason.EmptyResource, event);
        };

        this.audio.ontimeupdate = () => {
            this.emit('timeUpdate', {
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
            });
        };

        // timeupdate 只有 ~4Hz，跳转后最多 250ms 才刷新一次进度。
        // 这里在 seek 落点确认后立刻补发一次，让进度条与歌词高亮同步跟上。
        this.audio.onseeked = () => {
            this.emit('timeUpdate', {
                currentTime: this.audio.currentTime,
                // duration 未就绪时保持 Infinity（与 progressAtom 初值一致，避免显示成 0:00）
                duration: this.audio.duration || Infinity,
            });
        };

        this.audio.onended = () => {
            this.setPlayerState(PlayerState.Paused);
            this.emit('ended');
        };

        this.audio.onvolumechange = () => {
            this.emit('volumeChange', this.audio.volume);
        };

        this.audio.onratechange = () => {
            this.emit('speedChange', this.audio.playbackRate);
        };
    }

    private setPlayerState(state: PlayerState): void {
        if (this._playerState !== state) {
            this._playerState = state;
            this.emit('stateChange', state);
        }
    }

    // ─── HLS ───

    private initHls(): void {
        this.destroyHls();
        this.hls = new Hls();
        this.hls.attachMedia(this.audio);

        this.hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (data.fatal) {
                this.emit('error', ErrorReason.EmptyResource, data);
            }
        });
    }

    private destroyHls(): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    private isHls(url: string): boolean {
        try {
            const pathname = new URL(url).pathname;
            return pathname.endsWith('.m3u8');
        } catch {
            return url.includes('.m3u8');
        }
    }

    private revokeBlobUrl(): void {
        if (this._currentBlobUrl) {
            URL.revokeObjectURL(this._currentBlobUrl);
            this._currentBlobUrl = null;
        }
    }

    /** 从 URL 的 userinfo 部分提取 Basic Auth 凭证 */
    private extractBasicAuth(url: string): { cleanUrl: string; authHeader?: string } {
        try {
            const parsed = new URL(url);
            if (parsed.username) {
                const auth =
                    'Basic ' +
                    btoa(
                        decodeURIComponent(parsed.username) +
                            ':' +
                            decodeURIComponent(parsed.password),
                    );
                parsed.username = '';
                parsed.password = '';
                return { cleanUrl: parsed.href, authHeader: auth };
            }
        } catch {
            /* not a valid URL, skip */
        }
        return { cleanUrl: url };
    }

    private buildHeaders(source: IPlugin.IMediaSourceResult): Record<string, string> | null {
        const headers: Record<string, string> = {};
        if (source.headers) {
            Object.assign(headers, source.headers);
        }
        if (source.userAgent) {
            headers['User-Agent'] = source.userAgent;
        }
        return Object.keys(headers).length > 0 ? headers : null;
    }
}

// ─── 工厂模式 ───

export type AudioControllerFactory = () => IAudioController;

const controllerFactories: Record<string, AudioControllerFactory> = {
    'web-audio': () => new WebAudioController(),
    // 未来：
    // 'mpv': () => new MpvAudioController(),
};

export function createAudioController(type = 'web-audio'): IAudioController {
    const factory = controllerFactories[type];
    if (!factory) throw new Error(`Unknown audio controller: ${type}`);
    return factory();
}
