// ============================================================================
// usePlayerPopover — 播放栏气泡面板的公共开关逻辑
// ============================================================================
//
// 三个面板（音质 / 倍速 / 音量）原本各自复制了一份「hover 延迟开关 + classList 切
// is-visible」，有两个问题：
//
//   1. **只认鼠标**：键盘 Tab 到触发按钮时面板不展开，可面板里的滑条/选项**仍然在
//      Tab 序列里**（tabIndex=0）。于是焦点落进 opacity:0 的元素，焦点环画在透明元素上
//      ——「Tab 几下之后环就不见了 / 看不到选中的」就是从这里来的。
//   2. **各自监听 Esc** 会和 core/overlay 的全局 Esc 打架（一发 Esc 把底下的全屏播放页
//      也关掉）。
//
// 现在统一到这里：
//   - 开：hover 延迟 120ms 展开；**键盘聚焦立即展开**（不等延迟）
//   - 关：hover 离开延迟 200ms 收起；**焦点离开容器立即收起**（用 relatedTarget 判断，
//     焦点在「触发按钮 → 面板滑条」之间挪动不算离开）
//   - 面板内容只在展开时才可聚焦：`panelTabIndex`（收起时 -1，彻底退出 Tab 序列）
//   - 展开期间按 OVERLAY_LAYER.popover 注册进 core/overlay：Esc 先关面板并回焦到触发按钮

import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import { OVERLAY_LAYER, registerOverlay } from '@renderer/mainWindow/core/overlay';

/** hover 展开延迟：避免鼠标划过时误弹 */
const OPEN_DELAY = 120;
/** hover 离开后的收起延迟：给鼠标留出「移动到面板上」的时间 */
const CLOSE_DELAY = 200;

export function usePlayerPopover() {
    const [open, setOpen] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 容器（触发按钮 + 面板）：判断焦点是否还在这一层里 */
    const containerRef = useRef<HTMLDivElement>(null);
    /** 触发按钮：Esc 关面板后把焦点还给它 */
    const triggerRef = useRef<HTMLButtonElement>(null);
    /**
     * Esc 关闭后会把焦点还给触发按钮，而「聚焦即展开」会立刻又把它打开。
     * 这个标记用来吃掉那一次由回焦引起的展开。
     */
    const skipFocusOpenRef = useRef(false);
    /** 当前注册进 core/overlay 的注销函数（关闭时要**同步**注销，见下） */
    const unregisterRef = useRef<(() => void) | null>(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const schedule = useCallback(
        (next: boolean, delay: number) => {
            clearTimer();
            timerRef.current = setTimeout(() => setOpen(next), delay);
        },
        [clearTimer],
    );

    useEffect(() => clearTimer, [clearTimer]);

    /**
     * 关面板：**同步**从 core/overlay 注销，再把焦点还给触发按钮。
     *
     * 注销必须同步：注册是在 effect 里、注销原本也在 effect 清理里，而 effect 是渲染提交后
     * 才跑的 —— 这中间「已经关掉的气泡」还占着最上层，会把下一发 Esc 吃掉（表现为按了没反应，
     * 要多按一次才能关掉底下的全屏页 / 抽屉）。
     */
    const closePopover = useCallback(() => {
        unregisterRef.current?.();
        unregisterRef.current = null;
        setOpen(false);
        skipFocusOpenRef.current = true;
        triggerRef.current?.focus();
    }, []);

    // Esc 归属：面板展开期间注册成 popover 层（层级高于全屏播放页），一发 Esc 只关它
    useEffect(() => {
        if (!open) return;
        const unregister = registerOverlay({
            layer: OVERLAY_LAYER.popover,
            element: () => containerRef.current,
            close: closePopover,
        });
        unregisterRef.current = unregister;
        return () => {
            unregisterRef.current = null;
            unregister();
        };
    }, [open, closePopover, containerRef]);

    const onFocus = useCallback(() => {
        if (skipFocusOpenRef.current) {
            skipFocusOpenRef.current = false;
            return;
        }
        clearTimer();
        setOpen(true);
    }, [clearTimer]);

    const onBlur = useCallback(
        (e: FocusEvent<HTMLDivElement>) => {
            // 焦点在容器内部挪动（触发按钮 → 面板滑条）不算离开
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            clearTimer();
            setOpen(false);
        },
        [clearTimer],
    );

    return {
        open,
        containerRef,
        triggerRef,
        /** 面板内元素收起时的 tabIndex（-1 = 退出 Tab 序列） */
        panelTabIndex: open ? 0 : -1,
        containerProps: {
            ref: containerRef,
            onMouseEnter: () => schedule(true, OPEN_DELAY),
            onMouseLeave: () => schedule(false, CLOSE_DELAY),
            onFocus,
            onBlur,
        },
    };
}
