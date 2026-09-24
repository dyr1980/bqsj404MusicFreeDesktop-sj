// ============================================================================
// SpeedPopover — 倍速垂直气泡面板
// ============================================================================
//
// 倍速按钮 + 垂直滑条面板。开关逻辑见 usePlayerPopover（hover / 键盘聚焦都能展开，
// 且面板收起时滑条自动退出 Tab 序列）。
// 范围: 0.25x ~ 3x，面板内支持拖拽、滚轮与键盘调节。

import { useCallback, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import { cn } from '@common/cn';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useSpeed } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { usePlayerPopover } from './usePlayerPopover';

/** 倍速范围 */
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_RANGE = SPEED_MAX - SPEED_MIN; // 2.75

/** 每次滚轮步进 */
const WHEEL_STEP = 0.25;
/** 方向键微调步进 */
const ARROW_STEP = 0.05;

/** 倍速值 → 百分比 (0~100) */
function speedToPct(speed: number): number {
    return ((speed - SPEED_MIN) / SPEED_RANGE) * 100;
}

/** 百分比 (0~1) → 倍速值，snap 到最近的 0.05 */
function pctToSpeed(pct: number): number {
    const raw = SPEED_MIN + pct * SPEED_RANGE;
    return Math.round(raw * 20) / 20; // snap to 0.05
}

/** 格式化倍速显示 */
function formatSpeed(speed: number): string {
    // 整数显示 "1x"，一位小数显示 "1.5x"，两位显示 "0.25x"
    if (Number.isInteger(speed)) return `${speed}x`;
    if (Number.isInteger(speed * 10)) return `${speed.toFixed(1)}x`;
    return `${speed.toFixed(2)}x`;
}

/**
 * SpeedPopover
 *
 * - hover 延迟 120ms 打开 / 200ms 关闭；键盘聚焦立即打开，焦点离开立即关闭
 * - 垂直滑条：4px × 100px，pointer-capture 拖拽
 * - 鼠标滚轮：±0.25x
 * - 键盘：↑↓ 微调 ±0.05x（Shift ±0.25x）、PgUp/PgDn ±0.25x、Home/End 到 0.25x/3x
 */
const SpeedPopover = memo(function SpeedPopover() {
    const { t } = useTranslation();
    const speed = useSpeed();

    const { open, containerRef, triggerRef, panelTabIndex, containerProps } = usePlayerPopover();
    const trackRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const prevSpeedRef = useRef(1);
    /** 供原生 wheel listener 读取最新值，避免闭包过时 */
    const speedRef = useRef(speed);
    speedRef.current = speed;

    // ── 垂直滑条拖拽 ──

    const setSpeedFromPointer = useCallback((clientY: number) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
        trackPlayer.setSpeed(pctToSpeed(pct));
    }, []);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            isDraggingRef.current = true;
            setSpeedFromPointer(e.clientY);
        },
        [setSpeedFromPointer],
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDraggingRef.current) return;
            setSpeedFromPointer(e.clientY);
        },
        [setSpeedFromPointer],
    );

    const handlePointerUp = useCallback(() => {
        isDraggingRef.current = false;
    }, []);

    // ── 键盘调节（WAI-ARIA slider 惯例） ──

    const handleTrackKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const step = e.shiftKey ? WHEEL_STEP : ARROW_STEP;
            let next: number;
            switch (e.key) {
                case 'ArrowUp':
                    next = speed + step;
                    break;
                case 'ArrowDown':
                    next = speed - step;
                    break;
                case 'PageUp':
                    next = speed + WHEEL_STEP;
                    break;
                case 'PageDown':
                    next = speed - WHEEL_STEP;
                    break;
                case 'Home':
                    next = SPEED_MIN;
                    break;
                case 'End':
                    next = SPEED_MAX;
                    break;
                default:
                    return;
            }
            e.preventDefault();
            // snap 到 0.05，与拖拽/滚轮保持一致
            const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, next));
            trackPlayer.setSpeed(Math.round(clamped * 20) / 20);
        },
        [speed],
    );

    // ── 滚轮调节（原生事件：React onWheel 是 passive，无法 preventDefault） ──

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
            const next = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speedRef.current + delta));
            trackPlayer.setSpeed(Math.round(next * 20) / 20);
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [containerRef]);

    const pct = speedToPct(speed);

    return (
        <div className="l-player-bar__popover-anchor" {...containerProps}>
            {/* 触发按钮 */}
            <button
                ref={triggerRef}
                className="l-player-bar__ctrl-btn"
                type="button"
                data-roving-item
                title={t('playback.speed_title', { speed: formatSpeed(speed) })}
                // 面板展开时，焦点还在按钮上也能直接用 ↑↓ 调倍速
                onKeyDown={open ? handleTrackKeyDown : undefined}
                onClick={() => {
                    if (Math.abs(speed - 1) < 0.01) {
                        // 当前1x → 恢复之前的倍速
                        trackPlayer.setSpeed(prevSpeedRef.current !== 1 ? prevSpeedRef.current : 1);
                    } else {
                        // 当前非1x → 保存当前值，切回1x
                        prevSpeedRef.current = speed;
                        trackPlayer.setSpeed(1);
                    }
                }}
            >
                <Gauge size={15} />
            </button>

            {/* 气泡面板 */}
            <div className={cn('l-player-bar__popover', open && 'is-visible')}>
                <span className="l-player-bar__popover-value">{formatSpeed(speed)}</span>
                <div
                    ref={trackRef}
                    className="l-player-bar__popover-track"
                    role="slider"
                    aria-label={t('playback.speed')}
                    aria-orientation="vertical"
                    aria-valuemin={0.25}
                    aria-valuemax={3}
                    aria-valuenow={speed}
                    aria-valuetext={formatSpeed(speed)}
                    tabIndex={panelTabIndex}
                    onKeyDown={handleTrackKeyDown}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onLostPointerCapture={handlePointerUp}
                >
                    <div className="l-player-bar__popover-fill" style={{ height: `${pct}%` }} />
                    <div className="l-player-bar__popover-thumb" style={{ bottom: `${pct}%` }} />
                </div>
            </div>
        </div>
    );
});

export default SpeedPopover;
