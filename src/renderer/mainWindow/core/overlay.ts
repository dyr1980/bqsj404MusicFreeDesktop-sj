/**
 * overlay — 浮层与多选的「Esc 归属」仲裁
 *
 * 全应用只有这一个 Esc 裁决点（window 捕获阶段，先于其它任何监听），
 * **一次只退一层**，顺序由内到外：
 *   1. **键盘焦点环亮着** → 退出焦点状态（blur），焦点环消失
 *   2. 有选中项 → 清空那个列表的选中
 *   3. 还有浮层 → 关掉**最上面那一层**，一次只关一层
 *   4. 什么都没有 → 不拦（输入框、下拉自己的 Esc 照旧）
 *
 * 第 1 条的两个前提：
 *   - 焦点**不在最上层浮层里** —— 在气泡面板 / 右键菜单 / 弹窗 / 全屏页里时，
 *     这一发 Esc 应该去关那个浮层（交给第 3 条），否则弹窗要按两次 Esc 才关得掉；
 *   - 该元素自己没处理这一发（`defaultPrevented`）—— 输入框清空搜索之类的照旧。
 *
 * 以前每个浮层各自 `window.addEventListener('keydown')`，互相不知道对方存在：
 * 「全屏播放器 + 播放队列抽屉」同时开着时，一发 Esc 两个都关；多选又因为
 * `isOverlayOpen()` 被浮层挡住而清不掉。现在浮层**注册**进来（layer 决定谁在上面），
 * 由这里统一决定这一发 Esc 归谁。
 *
 * 「有选中项」只看用户**最后点过的那个列表**（`markSelectionRoot`），并且要求这个
 * 列表没有被最上层浮层盖住 —— 盖住了（比如歌单页选中后打开了弹窗）就先关浮层。
 */

import { isEscapeKey, isLastInteractedRoot } from './selection';

/** 层级：越大越靠上，Esc 先关它 */
export const OVERLAY_LAYER = {
    /** 全屏播放器 */
    fullscreen: 10,
    /** 抽屉（播放队列） */
    drawer: 20,
    /** 弹窗 */
    modal: 30,
    /** 更上层的小浮层：右键菜单 / 下拉面板 / 对时准星 */
    popover: 40,
} as const;

export interface IOverlayEntry {
    /** 层级 */
    layer: number;
    /** 这一层的面板元素（用来判断「列表是不是就在这一层里」） */
    element: () => HTMLElement | null;
    /** 关掉这一层 */
    close: () => void;
}

const entries: IOverlayEntry[] = [];

/** 注册一层浮层；返回注销函数（在 effect 清理里调用） */
export function registerOverlay(entry: IOverlayEntry): () => void {
    entries.push(entry);
    return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
    };
}

/** 最上面那一层（层级相同 → 后注册的算上面） */
export function topOverlay(): IOverlayEntry | null {
    let top: IOverlayEntry | null = null;
    for (const entry of entries) {
        if (!top || entry.layer >= top.layer) top = entry;
    }
    return top;
}

/** 当前有没有浮层开着 */
export function isOverlayOpen(): boolean {
    return topOverlay() !== null;
}

/** 关掉最上面那一层；没有浮层返回 false */
export function closeTopOverlay(): boolean {
    if (!isOverlayOpen()) return false;
    const top = topOverlay() as IOverlayEntry;
    top.close();
    return true;
}

// ────────────────────────────────────────────────────────────────────────────
// 多选选区
// ────────────────────────────────────────────────────────────────────────────

/** 可多选列表登记进来的信息（Esc 清选用） */
export interface ISelectionProvider {
    /** 列表根元素 */
    root: () => HTMLElement | null;
    /** 现在有没有选中项 */
    hasSelection: () => boolean;
    /** 清空选中 */
    clear: () => void;
}

const providers = new Set<ISelectionProvider>();

export function registerSelectionProvider(provider: ISelectionProvider): () => void {
    providers.add(provider);
    return () => {
        providers.delete(provider);
    };
}

/**
 * 这一发 Esc 该清哪个列表的选中：要同时满足
 *   - 有选中项
 *   - 列表还挂在文档里（已经关掉的弹窗 / 抽屉里的列表不算）
 *   - 是用户最后点过的那个列表（不看焦点在哪：弹窗里点过列表后焦点可能已经跑掉）
 *   - 没有被最上层浮层盖住
 */
function selectionToClear(): ISelectionProvider | null {
    const top = topOverlay();
    const topElement = top?.element() ?? null;

    for (const provider of providers) {
        const root = provider.root();
        if (!root || !root.isConnected) continue;
        if (!provider.hasSelection()) continue;
        if (!isLastInteractedRoot(root)) continue;
        if (topElement && !topElement.contains(root)) continue;
        return provider;
    }
    return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 全局 Esc
// ────────────────────────────────────────────────────────────────────────────

/**
 * 最近一次交互方式。
 *
 * 用来判断「这一发 Esc 到来**之前**，键盘焦点环是不是本来就亮着」：
 * Chromium 在 keydown 时才会把模态切成键盘，所以按下 Esc 的那一刻
 * `:focus-visible` 已经翻亮了 —— 如果只看这个伪类，那么「鼠标点选了几行再按 Esc」
 * 会被误判成「环亮着」而只做 blur，把原本一次就能清掉的选中变成要按两次。
 * 只有上一次交互本身就是键盘（Tab / 方向键…）时，那个环才是用户真正看到的那个环。
 */
let lastModality: 'keyboard' | 'pointer' = 'pointer';

function onPointerDown(): void {
    lastModality = 'pointer';
}

/**
 * 这一发 Esc 该退掉的那个「键盘焦点」。
 *
 * 只在**焦点环真的亮着**（`:focus-visible`）且焦点不在最上层浮层里时才成立 ——
 * 焦点环是键盘导航状态的外在表现，Esc 是「退出这个状态」的直觉手势。
 * 输入框 / 可编辑元素自己的 Esc 行为在前面的 `defaultPrevented` 已经让过路了。
 */
function focusToClear(): HTMLElement | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    if (!el.matches(':focus-visible')) return null;

    const topElement = topOverlay()?.element() ?? null;
    if (topElement && topElement.contains(el)) return null;

    return el;
}

function onKeyDown(e: KeyboardEvent): void {
    const wasKeyboard = lastModality === 'keyboard';
    lastModality = 'keyboard';

    if (!isEscapeKey(e)) return;
    // 别人已经处理过这一发（比如输入框自己吃掉）→ 不抢
    if (e.defaultPrevented) return;

    // 1. 键盘焦点环亮着 → 退出焦点状态（焦点环消失；下一次 Tab 重新进入键盘导航）
    const focused = wasKeyboard ? focusToClear() : null;
    if (focused) {
        e.preventDefault();
        focused.blur();
        return;
    }

    // 2. 有选中项 → 清空选中
    const selection = selectionToClear();
    if (selection) {
        // 只 preventDefault：输入框之类的 Esc行为（清空搜索、关候选）还要照常跑
        e.preventDefault();
        selection.clear();
        return;
    }

    // 3. 关最上面那一层浮层
    const top = topOverlay();
    if (top) {
        // 关浮层就是「这一发 Esc 归我」：不要再让底下的抽屉 / 输入框跟着处理
        e.preventDefault();
        e.stopImmediatePropagation();
        top.close();
    }
}

let listening = false;

/** 挂上全局 Esc（幂等；模块加载时自动调用一次） */
export function setupOverlayEscape(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('keydown', onKeyDown, true);
    // 记下「最近一次是鼠标交互」：判断焦点环是不是本来就亮着（见 lastModality）
    window.addEventListener('pointerdown', onPointerDown, true);
}

setupOverlayEscape();
