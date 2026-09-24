// ============================================================================
// LyricPanel — 歌词滚动面板
// ============================================================================
//
// 独立订阅 currentLyricAtom，隔离高频更新，避免整个 FullscreenPlayer 重渲染。
// 高亮行变化时把该行滚到容器中心（算法在 lyricAutoScroll.ts）。
//
// 拖拽选时（对标移动端歌词页）：
//   按住歌词区域上下拖动 → 面板中心出现准星（时间 + 播放按钮），
//   拖动时只高亮「准星所指的那一行」但不跳转；点播放按钮才真正 seek。
//   松手后准星保留，可再拖动微调；4s 无操作自动回落跟随播放进度。

import { useRef, useEffect, useCallback, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, TimerReset } from 'lucide-react';
import formatDuration from '@common/formatDuration';
import { cn } from '@common/cn';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { useLyric, useProgress } from '@renderer/mainWindow/core/trackPlayer/hooks';
import type { IParsedLrcItem } from '@common/lyricParser';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { OVERLAY_LAYER, registerOverlay } from '@renderer/mainWindow/core/overlay';
import { LYRIC_OFFSET_LIMIT } from '@renderer/mainWindow/core/trackPlayer/lyricManager';
import {
    resolveCrosshairIndex,
    resolveSeekTime,
    type ILyricLineMetrics,
} from '@renderer/mainWindow/core/lyricSeek';
import LyricAutoScroll from './lyricAutoScroll';

interface LyricPanelProps {
    /** 字号缩放比例 (0.8 ~ 1.3) */
    fontScale: number;
    /** 是否显示翻译 */
    showTranslation: boolean;
}

/** 活跃行基准字号 (px) — 对标设计稿 32px */
const ACTIVE_BASE_SIZE = 32;
/** 非活跃行基准字号 (px) — 对标设计稿 22px */
const INACTIVE_BASE_SIZE = 22;

/** 拖拽判定阈值 (px)，移动距离超过此值视为拖拽而非点击 */
const DRAG_THRESHOLD = 5;
/** 准星无操作自动取消的时长 (ms) */
const TARGETING_TIMEOUT_MS = 5000;

/** 检测用户是否偏好减少动画 */
const prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const LyricPanel = memo(function LyricPanel({ fontScale, showTranslation }: LyricPanelProps) {
    const { t } = useTranslation();
    const lyricState = useLyric();
    const progress = useProgress();
    const containerRef = useRef<HTMLDivElement>(null);
    const isInitialRef = useRef(true);

    // 拖拽滚动状态
    const dragState = useRef({
        isDragging: false,
        startY: 0,
        startScrollTop: 0,
        hasMoved: false,
    });

    // 拖拽完成标记，供 click 事件判断（click 在 pointerup 之后触发）
    const wasDraggedRef = useRef(false);

    // 自动跟随滚动：算法与状态都在控制器里，组件只负责接上 DOM 与回调
    const [scrollSync, forceScrollSync] = useState(0);
    const autoScrollRef = useRef<LyricAutoScroll | null>(null);
    if (autoScrollRef.current === null) {
        autoScrollRef.current = new LyricAutoScroll({
            onRerender: () => forceScrollSync((tick) => tick + 1),
            reducedMotion: prefersReducedMotion,
        });
    }

    const parser = lyricState?.parser;
    const currentLrc = lyricState?.currentLrc;
    const lyricItems = parser?.getLyricItems() ?? [];
    const activeIndex = currentLrc?.index ?? -1;

    // ── 拖拽选时状态 ──
    // 拖动中每帧都可能跨行，用 ref 记录 + forceUpdate 精准触发重渲染，
    // 避免每帧 setState 造成无意义的高频渲染。
    const [dragTick, forceUpdate] = useState(0);
    const isDraggingRef = useRef(false);
    const targetIndexRef = useRef<number | null>(null);
    /** 拖动中延后一帧的准星校准 */
    const settleFrameRef = useRef<number | null>(null);
    /** 准星无操作自动取消计时 */
    const targetingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 上一次使用的歌词解析器，用来识别「歌词换了一套」 */
    const lastParserRef = useRef<typeof parser>(undefined);

    const lyricOffset = trackPlayer.getLyricOffset();
    const { duration } = progress;

    // 准星行号存在 ref 里（拖动中每帧读写，不走 state），
    // 用 dragTick 让 React 认可这次变更后重新计算 targetItem
    const targetItem = dragTick ? (lyricItems[targetIndexRef.current ?? -1] ?? null) : null;
    const targetTime = targetItem ? resolveSeekTime(targetItem.time, lyricOffset, duration) : 0;

    // 容器一挂载/重建就交给控制器。
    //
    // 必须用 callback ref 而不是 useEffect([])：换歌词时面板会被卸载重建，
    // 控制器若还握着旧的（已脱离文档的）节点，offsetTop 会全是 0，
    // 自动跟随就在一个死元素上滚动 —— 表现就是换词后视图完全不动。
    const attachContainer = useCallback((el: HTMLDivElement | null) => {
        containerRef.current = el;
        autoScrollRef.current?.setContainer(el);
    }, []);

    // 歌词换了一套（搜索换词 / 关联歌词 / 切歌重载）→ 让控制器忘掉「已跟随的行号」。
    // 否则新旧歌词行号撞号时 follow() 会直接返回，视图停在上一次的位置不动。
    // 带上 activeIndex 是为了覆盖「换词时索引刚好没变」：解析器换了但 follow 的
    // effect 没机会重跑，这里靠解析器指纹变化强行同步一次。
    useEffect(() => {
        if (parser === lastParserRef.current) return;
        lastParserRef.current = parser;
        autoScrollRef.current?.resetFollowed();
        forceScrollSync((tick) => tick + 1);
    }, [parser, activeIndex]);

    // 当高亮行变化时把它滚到中心。
    //
    // 依赖里必须带上 scrollSync：用户滚动后的宽限期结束时，控制器靠 onRerender()
    // 把 scrollSync 加一（此时 activeIndex 往往没变），没有它这次「补滚」就永远不会执行，
    // 高亮行会一直停在画面外，越往后拖越远。
    useEffect(() => {
        if (targetIndexRef.current !== null) return;
        const container = containerRef.current;
        const controller = autoScrollRef.current;
        if (!container || !controller) return;

        if (isInitialRef.current) {
            isInitialRef.current = false;
        }
        controller.follow(activeIndex, (index) =>
            container.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`),
        );
    }, [activeIndex, scrollSync]);

    /** 退出选时状态，恢复跟随播放进度 */
    const clearTarget = useCallback(() => {
        if (targetIndexRef.current === null && !isDraggingRef.current) return;
        targetIndexRef.current = null;
        isDraggingRef.current = false;
        forceUpdate((tick) => tick + 1);
    }, []);

    /** 清掉自动取消计时（退出选时、卸载时用） */
    const clearTargetingTimer = useCallback(() => {
        if (targetingTimerRef.current !== null) {
            clearTimeout(targetingTimerRef.current);
            targetingTimerRef.current = null;
        }
    }, []);

    /**
     * 退出选时：收起准星并立即恢复跟随播放进度。
     *
     * 右键 / Esc / 5 秒无操作都走这条，行为一致：不跳转，直接回到当前播放行。
     */
    const endTargeting = useCallback(() => {
        clearTargetingTimer();
        clearTarget();
        autoScrollRef.current?.resume();
    }, [clearTargetingTimer, clearTarget]);

    /** 续期自动取消计时；拖拽时每动一下都会重置 */
    const beginTargeting = useCallback(() => {
        clearTargetingTimer();
        targetingTimerRef.current = setTimeout(() => {
            targetingTimerRef.current = null;
            endTargeting();
        }, TARGETING_TIMEOUT_MS);
    }, [clearTargetingTimer, endTargeting]);

    /** 定位准星所指的歌词行：取滚动区域内垂直居中点的行 */
    const measureTargetIndex = useCallback((): number | null => {
        const container = containerRef.current;
        if (!container) return null;

        // 只用「滚动内容坐标系」：offsetTop 与 scrollTop 同源，天然自洽。
        //
        // 千万不要混用 scrollTop 与 getBoundingClientRect()：滚动是合成器线程
        // 异步提交的，屏幕坐标与主线程的 scrollTop 可能短暂不一致，
        // 判据会因此整体偏移、压到差很远的一行（实测能差 20+ 行）。
        // 准星横线定位在滚动区垂直中心，且滚动容器与 lyric-panel 同顶同高
        // （正文里没有 margin），所以判据点就是 scrollTop + clientHeight / 2。
        const centerY = container.scrollTop + container.clientHeight / 2;

        const lines: ILyricLineMetrics[] = [];
        for (const el of container.querySelectorAll<HTMLElement>('[data-lyric-index]')) {
            lines.push({
                index: Number(el.dataset.lyricIndex),
                offsetTop: el.offsetTop,
                offsetHeight: el.offsetHeight,
            });
        }

        return resolveCrosshairIndex(lines, centerY);
    }, []);

    /** 写入准星行号；仅跨行时触发重渲染 */
    const commitTargetIndex = useCallback((index: number | null) => {
        if (index === targetIndexRef.current) return;
        targetIndexRef.current = index;
        forceUpdate((tick) => tick + 1);
    }, []);

    /** 按拖动位移同步滚动位置与准星行 */
    const applyDrag = useCallback(
        (deltaY: number) => {
            const container = containerRef.current;
            if (!container) return;

            const state = dragState.current;
            container.scrollTop = state.startScrollTop - deltaY;
            commitTargetIndex(measureTargetIndex());

            // 准星行会切到活跃字号，行高随之改变；等这一帧布局落定后再校准一次，
            // 避免「行高变化 → 中心点落到相邻行 → 字号再变」的来回跳行
            if (settleFrameRef.current !== null) {
                cancelAnimationFrame(settleFrameRef.current);
            }
            settleFrameRef.current = requestAnimationFrame(() => {
                settleFrameRef.current = null;
                if (!dragState.current.isDragging) return;
                commitTargetIndex(measureTargetIndex());
            });
        },
        [measureTargetIndex, commitTargetIndex],
    );

    /** 拖拽界面是否可见（准星已建立）。可见时它是 Esc 的最上层：先取消对时 */
    const targeting = targetItem !== null;

    // Esc 取消对时：注册成最上层浮层，比全屏播放器更靠上，
    // 所以这一发 Esc 只取消准星，不会顺带退出全屏
    useEffect(() => {
        if (!targeting) return;
        return registerOverlay({
            layer: OVERLAY_LAYER.popover,
            element: () => containerRef.current,
            close: endTargeting,
        });
    }, [targeting, endTargeting]);

    /** 拖拽开始 */
    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const container = containerRef.current;
            if (!container || e.button !== 0) return;

            // 用户接管滚动：停掉正在跑的居中动画，并起算宽限期
            autoScrollRef.current?.takeOver();

            dragState.current = {
                isDragging: true,
                startY: e.clientY,
                startScrollTop: container.scrollTop,
                hasMoved: false,
            };

            wasDraggedRef.current = false;
            isDraggingRef.current = true;
            // 按下即建立准星，拖动前就能看到当前中心行的时间
            const index = measureTargetIndex();
            // 上一次的准星行已恢复非活跃字号，直接把引用写空避免多一帧大字号闪烁
            targetIndexRef.current = null;
            commitTargetIndex(index);

            container.classList.add('is-dragging');
            // 捕获指针：拖到窗口外也能继续接收事件，松手一定收得到
            container.setPointerCapture(e.pointerId);
        },
        [measureTargetIndex, commitTargetIndex],
    );

    /** 拖拽移动 */
    const handlePointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const state = dragState.current;
            if (!state.isDragging) return;

            const deltaY = e.clientY - state.startY;

            if (!state.hasMoved && Math.abs(deltaY) > DRAG_THRESHOLD) {
                state.hasMoved = true;
            }

            if (state.hasMoved) {
                applyDrag(deltaY);
            }
        },
        [applyDrag],
    );

    /** 拖拽结束 */
    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const state = dragState.current;
            const container = containerRef.current;

            if (container) {
                container.classList.remove('is-dragging');
                if (container.hasPointerCapture(e.pointerId)) {
                    container.releasePointerCapture(e.pointerId);
                }
            }

            wasDraggedRef.current = state.hasMoved;
            isDraggingRef.current = false;

            if (state.hasMoved) {
                // 拖动过：从松手起算一个宽限期，期间不回弹到播放进度
                autoScrollRef.current?.pause();
            } else {
                // 只是点了一下（或点了准星上的播放键）：立刻恢复跟随
                autoScrollRef.current?.resume();
            }

            // 准星留着等用户点播放；但 5 秒没动作就自动收起
            beginTargeting();

            dragState.current = {
                isDragging: false,
                startY: 0,
                startScrollTop: 0,
                hasMoved: false,
            };
        },
        [beginTargeting],
    );

    /** 右键取消选时 */
    const handleContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (targetIndexRef.current === null) return;
            e.preventDefault();
            endTargeting();
        },
        [endTargeting],
    );

    /** 滚轮滚动：同样算用户接管，避免自动跟随把视图拽回去 */
    const handleWheel = useCallback(() => {
        autoScrollRef.current?.takeOver();
        // 滚轮也在操作准星，续期自动取消
        if (targetIndexRef.current !== null) beginTargeting();
    }, [beginTargeting]);

    /** 滚动区自身的 scroll 事件：交给控制器区分自家人与用户操作 */
    const handleScroll = useCallback(() => {
        autoScrollRef.current?.notifyScroll();
    }, []);

    /** 跳转到指定歌词行（点击行 / 点准星播放按钮共用） */
    const seekToTarget = useCallback(
        (time: number, holdAutoScroll = false) => {
            trackPlayer.seekTo(resolveSeekTime(time, trackPlayer.getLyricOffset(), duration));
            trackPlayer.resume();
            clearTargetingTimer();
            clearTarget();
            if (holdAutoScroll) {
                autoScrollRef.current?.pause();
            }
        },
        [duration, clearTargetingTimer, clearTarget],
    );

    /**
     * 把准星所指的这一行「对到当前播放时间」。
     *
     * 即调整歌词偏移，使这一行正好该在现在唱。公式：
     * 解析侧用 position = currentTime + userOffset 查行，
     * 要让第 T 秒的行对应此刻的播放位置 P，需要 userOffset = T - P。
     */
    const syncLyricOffset = useCallback(() => {
        const item = lyricItems[targetIndexRef.current ?? -1];
        if (!item) return;

        const currentTime = trackPlayer.getCurrentTime();
        const rawOffset = item.time - currentTime;
        const next = Math.min(Math.max(rawOffset, -LYRIC_OFFSET_LIMIT), LYRIC_OFFSET_LIMIT);
        trackPlayer.setLyricOffset(next);
        clearTargetingTimer();
        // 准星保留：方便对比调整后的高亮是否落到线上
        beginTargeting();
        showToast(
            t('lyric.offset_synced', {
                offset: `${next >= 0 ? '+' : ''}${next.toFixed(1)}`,
            }),
        );
    }, [lyricItems, clearTargetingTimer, beginTargeting, t]);

    /** 点击歌词行跳转播放位置（拖拽时不触发） */
    const handleLyricClick = useCallback(
        (item: IParsedLrcItem) => {
            if (wasDraggedRef.current) return;
            seekToTarget(item.time);
        },
        [seekToTarget],
    );

    // 清理计时器、待执行的校准帧与控制器
    useEffect(() => {
        const controller = autoScrollRef.current;
        return () => {
            clearTargetingTimer();
            if (settleFrameRef.current !== null) {
                cancelAnimationFrame(settleFrameRef.current);
            }
            controller?.destroy();
        };
    }, [clearTargetingTimer]);

    if (lyricItems.length === 0) {
        return (
            <div className="l-fullscreen-player__lyric-empty">
                <span
                    className="l-fullscreen-player__lyric-empty-text"
                    style={{ fontSize: `${INACTIVE_BASE_SIZE * fontScale}px` }}
                >
                    {t('lyric.no_lyric')}
                </span>
            </div>
        );
    }

    return (
        <div className="l-fullscreen-player__lyric-panel">
            <div
                ref={attachContainer}
                className="l-fullscreen-player__lyric-scroll"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleWheel}
                onScroll={handleScroll}
                onContextMenu={handleContextMenu}
            >
                {lyricItems.map((item) => {
                    const isTarget = targetItem?.index === item.index;
                    const isActive = !isDraggingRef.current && item.index === activeIndex;
                    const isEmphasized = isActive || isTarget;

                    return (
                        <div
                            key={item.index}
                            data-lyric-index={item.index}
                            className={cn(
                                'l-fullscreen-player__lyric-line',
                                isActive && 'is-active',
                                isTarget && 'is-target',
                            )}
                            style={{
                                fontSize: `${
                                    (isEmphasized ? ACTIVE_BASE_SIZE : INACTIVE_BASE_SIZE) *
                                    fontScale
                                }px`,
                            }}
                            onClick={() => handleLyricClick(item)}
                        >
                            <div className="l-fullscreen-player__lyric-text">{item.lrc}</div>
                            {showTranslation && item.translation && (
                                <div className="l-fullscreen-player__lyric-trans">
                                    {item.translation}
                                </div>
                            )}
                        </div>
                    );
                })}
                {/* 底部留白，确保最后一行能滚动到容器中心 */}
                <div className="l-fullscreen-player__lyric-spacer" />
            </div>

            {/* 拖拽选时准星：中心横线 + 目标时间 + 跳转按钮 */}
            {targetItem && (
                <div className="l-fullscreen-player__lyric-drag">
                    {/* 准星行是最后一行的最后一项，横线因此正好落在滚动区中心 */}
                    <div className="l-fullscreen-player__lyric-drag-row">
                        <button
                            className="l-fullscreen-player__lyric-drag-sync"
                            type="button"
                            title={t('lyric.sync_offset_here')}
                            aria-label={t('lyric.sync_offset_here')}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={syncLyricOffset}
                        >
                            <TimerReset size={14} />
                            <span className="l-fullscreen-player__lyric-drag-sync-text">
                                {t('lyric.sync_offset')}
                            </span>
                        </button>
                        <span className="l-fullscreen-player__lyric-drag-time">
                            {formatDuration(targetTime)}
                        </span>
                        <span className="l-fullscreen-player__lyric-drag-line" />

                        <div className="l-fullscreen-player__lyric-drag-action">
                            <span className="l-fullscreen-player__lyric-drag-hint">
                                {t('lyric.drag_to_seek')}
                            </span>
                            <button
                                className="l-fullscreen-player__lyric-drag-play"
                                type="button"
                                title={t('lyric.seek_to_here')}
                                aria-label={t('lyric.seek_to_here')}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => seekToTarget(targetItem.time, true)}
                            >
                                <Play size={16} fill="currentColor" />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default LyricPanel;
