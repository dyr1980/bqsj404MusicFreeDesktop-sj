// ============================================================================
// useRovingFocus — 焦点组（roving tabindex）
// ============================================================================
//
// 只解决一件事：**Tab 进组一次**。组内只有一个是 Tab 停靠点（tabIndex=0），
// 其余是 -1，Tab 进组、Tab 出组，不会为了走到组里第 9 个按钮按 9 下 Tab。
//
// 方向键**不在这里处理** —— 统一交给 `core/spatialFocus`：
// 面板展开时 ↑↓ 调滑条/选项（滑条与选项自己 preventDefault），
// 其他时候四个方向键都按「焦点当前在哪」去找界面上下一个元素。
//
// 用法：把 `containerProps` 展开到组容器上，给组内每个可聚焦元素加 `data-roving-item`。
//
//   const roving = useRovingFocus({ orientation: 'vertical', itemCount: list.length });
//   <nav {...roving.containerProps}>
//       <button data-roving-item>…</button>
//   </nav>
//
// 虚拟滚动列表（歌曲表格 / 队列）额外要：给行加 `ref={roving.registerItem}`，
// 行是虚拟列表自己插进 DOM 的，见 registerItem 的注释。

import { useCallback, useEffect, useRef, type FocusEvent } from 'react';

export type RovingOrientation = 'horizontal' | 'vertical';

/** 组内元素标记 */
const ITEM_ATTR = 'data-roving-item';
/** 组容器标记（用来识别嵌套组，避免外层把内层的项也当成自己的） */
const CONTAINER_ATTR = 'data-roving-container';

interface IUseRovingFocusOptions {
    orientation?: RovingOrientation;
    /**
     * 组内项目数量。列表增删后新元素默认 tabIndex=0，会出现多个 Tab 停靠点，
     * 靠这个数字变化触发一次重新收敛。
     */
    itemCount: number;
    /** focusItem() 到边界是否循环，默认 true */
    loop?: boolean;
}

export function useRovingFocus<T extends HTMLElement = HTMLDivElement>({
    orientation = 'vertical',
    itemCount,
    loop = true,
}: IUseRovingFocusOptions) {
    const containerRef = useRef<T>(null);
    /** 当前「组内活动项」下标：只记住下标，实际焦点始终由浏览器持有 */
    const activeRef = useRef(0);

    const getItems = useCallback((): HTMLElement[] => {
        const root = containerRef.current;
        if (!root) return [];
        return Array.from(root.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`)).filter(
            (el) =>
                // 嵌套组的项不归外层管
                el.closest(`[${CONTAINER_ATTR}]`) === root &&
                !el.hasAttribute('disabled') &&
                el.getAttribute('aria-disabled') !== 'true',
        );
    }, []);

    /** 把 tabIndex 收敛成「活动项 0，其余 -1」 */
    const syncTabIndex = useCallback(() => {
        const items = getItems();
        if (!items.length) return;
        const active = Math.min(activeRef.current, items.length - 1);
        items.forEach((el, index) => {
            el.tabIndex = index === active ? 0 : -1;
        });
    }, [getItems]);

    // 项目数量变化 → 重新收敛（新增项默认是 Tab 停靠点）
    useEffect(() => {
        syncTabIndex();
    }, [syncTabIndex, itemCount]);

    /**
     * 首屏兜底：虚拟列表的行是**由虚拟列表自己**在挂载之后插进来的，而外层组件
     * 不会再渲染一次 —— 只靠上面的 itemCount 收敛会赶在行出现之前跑完，之后又不触发。
     * （实测虚拟表格就是这样：MutationObserver 也收不到那一批插入，结果一个 tabIndex
     * 都没设上，行根本不可聚焦、Tab 直接跳过整张表。）
     *
     * 这里做**有限次**重试：只在「组里还没有项目」时继续，一旦出现项目就停，
     * 不用 rAF（窗口被遮挡时 rAF 会被节流甚至不执行），也不是无限轮询。
     */
    useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = () => {
            if (cancelled || attempts >= 5) return;
            attempts += 1;
            syncTabIndex();
            if (getItems().length === 0) {
                timer = setTimeout(tick, 60 * attempts);
            }
        };
        tick();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [syncTabIndex, getItems, itemCount]);

    /**
     * 虚拟滚动列表的行是**由虚拟列表自己渲染**的，外层组件不会因为「出行了」而重新渲染。
     * 上面那段重试负责首屏，这里负责之后的增删（滚动换行、数据变化）。
     *
     * 只监听 childList：syncTabIndex 改的是 tabIndex 属性，监听属性会自激成死循环。
     */
    useEffect(() => {
        const root = containerRef.current;
        if (!root || typeof MutationObserver === 'undefined') return;

        const observer = new MutationObserver(() => {
            // 直接同步收敛：MutationObserver 回调本身按微任务批量投递，不需要 rAF 合并
            // （窗口被遮挡时 rAF 会被节流甚至不执行）
            syncTabIndex();
        });
        observer.observe(root, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [syncTabIndex]);

    /**
     * 项挂载时的自注册（用在虚拟列表的项上：`ref={roving.registerItem}`）。
     *
     * 这是**唯一不依赖时序**的路径：行由虚拟列表插进来时立刻按当前活动下标写好
     * tabIndex，不用等外层重渲染、不用等 MutationObserver、不依赖 rAF
     * （实测虚拟表格里前两者都赶不上，行会一个 tabIndex 都没有、Tab 直接跳过整张表）。
     */
    const registerItem = useCallback(
        (el: HTMLElement | null) => {
            if (!el) return;
            const items = getItems();
            const index = items.indexOf(el);
            if (index < 0) return;
            el.tabIndex = index === activeRef.current ? 0 : -1;
        },
        [getItems],
    );

    const focusItem = useCallback(
        (index: number) => {
            const items = getItems();
            if (!items.length) return;
            const next = loop
                ? (index + items.length) % items.length
                : Math.max(0, Math.min(items.length - 1, index));
            activeRef.current = next;
            syncTabIndex();
            const el = items[next];
            el?.focus();
            // 长列表 / 侧栏里保证焦点项在可视区内（已在可视区则不动）
            el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        },
        [getItems, loop, syncTabIndex],
    );

    /**
     * 焦点进入组（Tab / 点击 / 程序化 / 方向键导航）→ 把活动下标对齐到它。
     *
     * 注意这里**不再处理方向键**：方向键统一交给 `core/spatialFocus`
     * （根据焦点位置在界面上找下一个元素），组只负责「Tab 进组一次」这件事。
     */
    const onFocus = useCallback(
        (e: FocusEvent) => {
            const items = getItems();
            const index = items.indexOf(e.target as HTMLElement);
            if (index < 0) return;
            activeRef.current = index;
            syncTabIndex();
        },
        [getItems, syncTabIndex],
    );

    return {
        containerRef,
        focusItem,
        registerItem,
        /**
         * 手动重新收敛 tabIndex。列表用虚拟滚动（行是随滚动增删的）或 JSX 里自己写了
         * tabIndex 时，渲染后调一次，避免出现多个 Tab 停靠点。
         */
        sync: syncTabIndex,
        containerProps: {
            ref: containerRef,
            [CONTAINER_ATTR]: '',
            // 组的形态（只做标注，方向键由 core/spatialFocus 统一处理）
            'data-focus-nav': orientation,
            onFocus,
        },
    };
}
