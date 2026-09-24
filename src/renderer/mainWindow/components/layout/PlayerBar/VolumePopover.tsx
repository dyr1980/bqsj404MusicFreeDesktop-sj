// ============================================================================
// VolumePopover — 音量垂直气泡面板
// ============================================================================
//
// 音量按钮 + 垂直滑条面板。开关逻辑见 usePlayerPopover（hover / 键盘聚焦都能展开，
// 且面板收起时滑条自动退出 Tab 序列）。
// 面板内：拖拽、点击定位、鼠标滚轮、以及键盘方向键调节。

import { useCallback, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@common/cn';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useVolume } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { getVolumeIcon } from '@renderer/common/volume';
import { usePlayerPopover } from './usePlayerPopover';

/** 每次滚轮 / 方向键步进 */
const WHEEL_STEP = 0.02;
/** PageUp / PageDown 步进 */
const PAGE_STEP = 0.1;

/**
 * VolumePopover
 *
 * - hover 延迟 120ms 打开 / 200ms 关闭；键盘聚焦立即打开，焦点离开立即关闭
 * - 垂直滑条：4px × 100px，pointer-capture 拖拽
 * - 鼠标滚轮：整个区域监听 wheel 事件，±2%
 * - 键盘：滑条聚焦时 ↑↓ 调 ±2%（Shift ±10%）、PgUp/PgDn ±10%、Home/End 到 0/100%
 */
const VolumePopover = memo(function VolumePopover() {
    const { t } = useTranslation();
    const volume = useVolume();
    const VolumeIcon = getVolumeIcon(volume);

    const { open, containerRef, triggerRef, panelTabIndex, containerProps } = usePlayerPopover();
    const trackRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const prevVolumeRef = useRef(1);
    /** 供原生 wheel listener 读取最新值，避免闭包过时 */
    const volumeRef = useRef(volume);
    volumeRef.current = volume;

    // ── 垂直滑条拖拽 ──

    const setVolumeFromPointer = useCallback((clientY: number) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        // 底部 = 0，顶部 = 1
        const pct = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
        trackPlayer.setVolume(pct);
    }, []);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            isDraggingRef.current = true;
            setVolumeFromPointer(e.clientY);
        },
        [setVolumeFromPointer],
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDraggingRef.current) return;
            setVolumeFromPointer(e.clientY);
        },
        [setVolumeFromPointer],
    );

    const handlePointerUp = useCallback(() => {
        isDraggingRef.current = false;
    }, []);

    // ── 键盘调节（WAI-ARIA slider 惯例：↑↓ 微调，PgUp/PgDn 粗调，Home/End 到两端） ──

    const handleTrackKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const step = e.shiftKey ? PAGE_STEP : WHEEL_STEP;
            let next: number;
            switch (e.key) {
                case 'ArrowUp':
                    next = volume + step;
                    break;
                case 'ArrowDown':
                    next = volume - step;
                    break;
                case 'PageUp':
                    next = volume + PAGE_STEP;
                    break;
                case 'PageDown':
                    next = volume - PAGE_STEP;
                    break;
                case 'Home':
                    next = 0;
                    break;
                case 'End':
                    next = 1;
                    break;
                default:
                    return;
            }
            e.preventDefault();
            trackPlayer.setVolume(Math.max(0, Math.min(1, Math.round(next * 100) / 100)));
        },
        [volume],
    );

    // ── 滚轮调节（原生事件：React onWheel 是 passive，无法 preventDefault） ──

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
            trackPlayer.setVolume(Math.max(0, Math.min(1, volumeRef.current + delta)));
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [containerRef]);

    const volumePct = Math.round(volume * 100);

    return (
        <div className="l-player-bar__popover-anchor" {...containerProps}>
            {/* 触发按钮 */}
            <button
                ref={triggerRef}
                className="l-player-bar__ctrl-btn"
                type="button"
                data-roving-item
                title={volume === 0 ? t('playback.unmute') : t('playback.mute')}
                // 面板展开时，焦点还在按钮上也能直接用 ↑↓ 调音量
                onKeyDown={open ? handleTrackKeyDown : undefined}
                onClick={() => {
                    if (volume === 0) {
                        trackPlayer.setVolume(prevVolumeRef.current || 1);
                    } else {
                        prevVolumeRef.current = volume;
                        trackPlayer.setVolume(0);
                    }
                }}
            >
                <VolumeIcon size={15} />
            </button>

            {/* 气泡面板 */}
            <div className={cn('l-player-bar__popover', open && 'is-visible')}>
                <span className="l-player-bar__popover-value">{volumePct}</span>
                <div
                    ref={trackRef}
                    className="l-player-bar__popover-track"
                    role="slider"
                    aria-label={t('playback.volume')}
                    aria-orientation="vertical"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={volumePct}
                    tabIndex={panelTabIndex}
                    onKeyDown={handleTrackKeyDown}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onLostPointerCapture={handlePointerUp}
                >
                    <div
                        className="l-player-bar__popover-fill"
                        style={{ height: `${volumePct}%` }}
                    />
                    <div
                        className="l-player-bar__popover-thumb"
                        style={{ bottom: `${volumePct}%` }}
                    />
                </div>
            </div>
        </div>
    );
});

export default VolumePopover;
