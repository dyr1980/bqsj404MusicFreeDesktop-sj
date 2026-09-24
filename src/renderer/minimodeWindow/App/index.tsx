// ============================================================================
// App — 迷你模式根组件
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SkipBack, SkipForward, Play, Pause, Heart } from 'lucide-react';
import { DesktopLyric, MiniModeExpand, TrayCollapse } from '@renderer/common/icons';
import { DefaultCover } from '@renderer/common/DefaultCover';
import { getVolumeIcon } from '@renderer/common/volume';
import { REPEAT_MODE_MAP } from '@renderer/common/repeatModeMap';
import { PlayerState, RepeatMode } from '@common/constant';
import appSyncAuxiliary, { useAppStatePartial } from '@infra/appSync/renderer/auxiliary';
import appConfig from '@infra/appConfig/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import windowDrag from '@infra/windowDrag/renderer';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import './index.scss';

/**
 * MiniMode App — 迷你模式窗口根组件
 * @layer layout
 *
 * 设计稿还原（像素级）：
 *   容器: 420×120, rounded-[20px], glass(bg-popover, blur-xl, border-default, shadow-xl)
 *         px-16, flex, items-center, gap-16
 *   封面: 72×72, rounded-2xl(16px), border, shadow
 *   信息: flex-1, min-w-0
 *     标题: text-sm(14px), font-semibold, text-primary, truncate
 *     副标题: text-xs(12px), text-secondary, truncate, mt-1(4px)
 *     进度条: mt-3(12px), h-1.5(6px), rounded-full, no thumb
 *   控制: flex-col, gap-3(12px)
 *     播放: gap-1(4px), prev(32×32) play(36×36, brand) next(32×32)
 *     工具: gap-2(8px), heart(32×32) lyric(32×32) repeat(32×32)
 */
export default function App() {
    const { t } = useTranslation();
    const musicItem = useAppStatePartial('musicItem');
    const playerState = useAppStatePartial('playerState');
    const repeatMode = useAppStatePartial('repeatMode');
    const progress = useAppStatePartial('progress');
    const isFavorite = useAppStatePartial('isFavorite');
    const volumeState = useAppStatePartial('volume');

    const [enableDesktopLyric] = useConfigValue('lyric.enableDesktopLyric');

    const isPlaying = playerState === PlayerState.Playing;
    const currentRepeatMode = repeatMode ?? RepeatMode.Queue;
    const { Icon: RepeatIcon, next: nextRepeatMode } = REPEAT_MODE_MAP[currentRepeatMode];

    // 音量：主窗口推过来的 0~1
    const volume = volumeState ?? 1;
    const isMuted = volume === 0;
    const VolumeIcon = getVolumeIcon(volume);
    const volumePct = Math.round(volume * 100);
    /** 记住静音前的音量，取消静音时恢复 */
    const lastVolumeRef = useRef(1);
    useEffect(() => {
        if (volume > 0) lastVolumeRef.current = volume;
    }, [volume]);

    /** 拖动音量条期间为 true：面板保持展开，且窗口拖拽被临时关掉 */
    const [draggingVolume, setDraggingVolume] = useState(false);
    const volumeTrackRef = useRef<HTMLDivElement>(null);

    /** 拖动进度条时为 0~1 的本地比例（推流是 1s 节流的，跟手要用本地值） */
    const [dragRatio, setDragRatio] = useState<number | null>(null);

    /** 封面加载失败 → 退回默认音符图 */
    const [artworkFailed, setArtworkFailed] = useState(false);
    useEffect(() => {
        setArtworkFailed(false);
    }, [musicItem?.artwork]);

    const duration = progress?.duration ?? 0;

    // 进度百分比：拖动时用本地值，避免被 1s 节流的推流拽回去
    const pushedPercent =
        progress && progress.duration > 0 && isFinite(progress.duration)
            ? (progress.currentTime / progress.duration) * 100
            : 0;
    const progressPercent = dragRatio !== null ? dragRatio * 100 : pushedPercent;

    // 订阅应用状态
    useEffect(() => {
        appSyncAuxiliary.subscribeAppState([
            'musicItem',
            'playerState',
            'repeatMode',
            'progress',
            'isFavorite',
            'volume',
        ]);
    }, []);

    // ─── 事件处理 ───

    const handleShowMainWindow = useCallback(() => {
        systemUtil.exitMinimode();
    }, []);

    /**
     * 收至托盘：隐藏迷你窗口，应用继续在托盘里播放。
     * 之后点托盘图标（或托盘菜单里的「退出迷你模式」）都能把主界面叫回来。
     */
    const handleMinimizeToTray = useCallback(() => {
        systemUtil.minimizeWindow(true);
    }, []);

    const handlePlayPause = useCallback(() => {
        appSyncAuxiliary.sendCommand('play/pause');
    }, []);

    const handleSkipPrev = useCallback(() => {
        appSyncAuxiliary.sendCommand('skip-previous');
    }, []);

    const handleSkipNext = useCallback(() => {
        appSyncAuxiliary.sendCommand('skip-next');
    }, []);

    const handleToggleFavorite = useCallback(() => {
        appSyncAuxiliary.sendCommand('like/dislike');
    }, []);

    const handleToggleDesktopLyric = useCallback(() => {
        const current = appConfig.getConfigByKey('lyric.enableDesktopLyric');
        appConfig.setConfig({
            'lyric.enableDesktopLyric': !current,
        });
    }, []);

    const handleToggleRepeatMode = useCallback(() => {
        appSyncAuxiliary.sendCommand('set-repeat-mode', nextRepeatMode);
    }, [nextRepeatMode]);

    /** 点图标 = 静音 / 取消静音（与主窗口音量按钮一致） */
    const handleToggleMute = useCallback(() => {
        appSyncAuxiliary.sendCommand('set-volume', isMuted ? lastVolumeRef.current || 1 : 0);
    }, [isMuted]);

    /**
     * 音量条：按下即定位，按住可以继续拖。
     *
     * 迷你窗口整块都是拖窗口的区域，所以按下时先把窗口拖拽关掉
     * （windowDrag.setDragEnabled(false)），松开再打开，
     * 否则拖着音量条会变成拖窗口。
     */
    const setVolumeFromClientX = useCallback((clientX: number) => {
        const rect = volumeTrackRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        appSyncAuxiliary.sendCommand('set-volume', pct);
    }, []);

    const handleVolumePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            windowDrag.setDragEnabled(false);
            setDraggingVolume(true);
            setVolumeFromClientX(e.clientX);
        },
        [setVolumeFromClientX],
    );

    const handleVolumePointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!draggingVolume) return;
            setVolumeFromClientX(e.clientX);
        },
        [draggingVolume, setVolumeFromClientX],
    );

    const handleVolumePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        setDraggingVolume(false);
        windowDrag.setDragEnabled(true);
    }, []);

    // 组件卸载时兜底恢复，避免拖拽被永久关掉
    useEffect(() => {
        return () => windowDrag.setDragEnabled(true);
    }, []);

    /** 滚轮微调 ±2% */
    const handleVolumeWheel = useCallback(
        (e: React.WheelEvent) => {
            const delta = e.deltaY < 0 ? 0.02 : -0.02;
            appSyncAuxiliary.sendCommand('set-volume', Math.max(0, Math.min(1, volume + delta)));
        },
        [volume],
    );

    /** 进度条：按下定位 + 按住拖动，同样是先关掉窗口拖拽 */
    const seekFromClientX = useCallback(
        (clientX: number, el: HTMLElement) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || !(duration > 0) || !isFinite(duration)) return;
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            setDragRatio(ratio);
            appSyncAuxiliary.sendCommand('set-progress', ratio * duration);
        },
        [duration],
    );

    const handleProgressPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            windowDrag.setDragEnabled(false);
            seekFromClientX(e.clientX, e.currentTarget);
        },
        [seekFromClientX],
    );

    const handleProgressPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (dragRatio === null) return;
            seekFromClientX(e.clientX, e.currentTarget);
        },
        [dragRatio, seekFromClientX],
    );

    const handleProgressPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        setDragRatio(null);
        windowDrag.setDragEnabled(true);
    }, []);

    /**
     * 空白处右键 → 当前播放歌曲的菜单。
     *
     * 迷你窗口只有 420×120，应用内菜单会被窗口边界裁掉，所以请主窗口
     * 构建菜单内容、由主进程弹系统原生菜单（坐标用屏幕坐标，弹在窗口外也行）。
     */
    const handleBlankContextMenu = useCallback(
        (e: React.MouseEvent<HTMLElement>) => {
            if (e.defaultPrevented) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, a, input, [role="slider"], .context-menu')) return;
            if (!musicItem) return;
            e.preventDefault();
            appSyncAuxiliary.sendCommand('open-current-music-menu', {
                x: e.screenX,
                y: e.screenY,
            });
        },
        [musicItem],
    );

    return (
        <div className="l-minimode" onContextMenu={handleBlankContextMenu}>
            {/* ── 封面（点击回到主窗口） ── */}
            <button
                type="button"
                className={`l-minimode__artwork${
                    !musicItem?.artwork || artworkFailed ? ' is-default' : ''
                }`}
                title={t('playback.expand_main_window')}
                onClick={handleShowMainWindow}
            >
                {musicItem?.artwork && !artworkFailed ? (
                    <img
                        className="l-minimode__artwork-img"
                        src={musicItem.artwork}
                        alt=""
                        draggable={false}
                        onError={() => setArtworkFailed(true)}
                    />
                ) : (
                    // 无封面 / 加载失败：黑白音符默认图（跟随主题色）
                    <span className="l-minimode__artwork-fallback">
                        <DefaultCover />
                    </span>
                )}
                <span className="l-minimode__artwork-overlay">
                    <MiniModeExpand size={20} />
                </span>
            </button>

            {/* ── 歌曲信息 + 进度条 ── */}
            <div className="l-minimode__info">
                <div className="l-minimode__title">
                    {musicItem?.title || (!musicItem ? t('playback.not_playing') : '')}
                </div>
                <div className="l-minimode__subtitle">
                    {[musicItem?.artist, musicItem?.album].filter(Boolean).join(' · ')}
                </div>
                <div
                    className={`l-minimode__progress${dragRatio !== null ? ' is-dragging' : ''}`}
                    role="slider"
                    aria-label={t('playback.progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progressPercent)}
                    onPointerDown={handleProgressPointerDown}
                    onPointerMove={handleProgressPointerMove}
                    onPointerUp={handleProgressPointerUp}
                    onLostPointerCapture={handleProgressPointerUp}
                >
                    <div
                        className="l-minimode__progress-fill"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
            </div>

            {/* ── 控制区域 ── */}
            <div className="l-minimode__controls">
                {/* 播放控制 */}
                <div className="l-minimode__playback">
                    <button type="button" className="l-minimode__ctrl-btn" onClick={handleSkipPrev}>
                        <SkipBack size={16} fill="currentColor" />
                    </button>
                    <button
                        type="button"
                        className="l-minimode__ctrl-btn l-minimode__ctrl-btn--play"
                        onClick={handlePlayPause}
                    >
                        {isPlaying ? (
                            <Pause size={16} fill="currentColor" />
                        ) : (
                            <Play size={16} fill="currentColor" style={{ marginLeft: 1 }} />
                        )}
                    </button>
                    <button type="button" className="l-minimode__ctrl-btn" onClick={handleSkipNext}>
                        <SkipForward size={16} fill="currentColor" />
                    </button>

                    {/* 音量：与上一曲/播放/下一曲同排，hover 向左浮出滑条 */}
                    <div
                        className={`l-minimode__volume${draggingVolume ? ' is-dragging' : ''}`}
                        onWheel={handleVolumeWheel}
                    >
                        <button
                            type="button"
                            className="l-minimode__ctrl-btn"
                            title={isMuted ? t('playback.unmute') : t('playback.mute')}
                            onClick={handleToggleMute}
                        >
                            <VolumeIcon size={16} />
                        </button>

                        <div className="l-minimode__volume-panel">
                            <span className="l-minimode__volume-value">{volumePct}</span>
                            <div
                                ref={volumeTrackRef}
                                className="l-minimode__volume-track"
                                role="slider"
                                aria-label={t('playback.volume')}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={volumePct}
                                onPointerDown={handleVolumePointerDown}
                                onPointerMove={handleVolumePointerMove}
                                onPointerUp={handleVolumePointerUp}
                                onLostPointerCapture={handleVolumePointerUp}
                            >
                                <div
                                    className="l-minimode__volume-fill"
                                    style={{ width: `${volumePct}%` }}
                                />
                                <div
                                    className="l-minimode__volume-thumb"
                                    style={{ left: `${volumePct}%` }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* 工具按钮 */}
                <div className="l-minimode__utility">
                    <button
                        type="button"
                        className={`l-minimode__util-btn${isFavorite ? ' is-favorite' : ''}`}
                        onClick={handleToggleFavorite}
                    >
                        <Heart size={14} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                    <button
                        type="button"
                        className={`l-minimode__util-btn${enableDesktopLyric ? ' is-active' : ''}`}
                        onClick={handleToggleDesktopLyric}
                    >
                        <DesktopLyric size={14} />
                    </button>
                    <button
                        type="button"
                        className="l-minimode__util-btn"
                        onClick={handleToggleRepeatMode}
                    >
                        <RepeatIcon size={14} />
                    </button>

                    {/* 收至托盘（放在「展开主界面」前面） */}
                    <button
                        type="button"
                        className="l-minimode__util-btn"
                        title={t('app.minimize_to_tray')}
                        onClick={handleMinimizeToTray}
                    >
                        <TrayCollapse size={14} />
                    </button>

                    <button
                        type="button"
                        className="l-minimode__util-btn"
                        title={t('playback.expand_main_window')}
                        onClick={handleShowMainWindow}
                    >
                        <MiniModeExpand size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
