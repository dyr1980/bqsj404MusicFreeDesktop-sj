/**
 * spatialFocus — 方向键的焦点移动（空间导航）
 *
 * 需求：**面板展开时 ↑↓ 调对应的选项/滑条，其他时候四个方向键都按「焦点现在在哪」
 * 去界面上找下一个元素**（不再按区域各管一维）。
 *
 * 所以方向键的归属顺序是：
 *   1. 目标元素自己（滑条、音质选项、输入框…）—— 它们会 preventDefault
 *   2. 这里：从当前焦点出发，按几何位置找那个方向上最合适的可聚焦元素
 *   3. 都没处理 → 留给 window 上的本地快捷键（tinykeys，见 infra/shortCut/renderer.ts）
 *
 * 事件挂在 **document 冒泡阶段**，正好卡在 1 和 3 中间：
 *   - React 17+ 把事件挂在 #root 上，比 document 深 → 先跑，先有机会 preventDefault
 *   - tinykeys 挂在 window 上，比 document 浅 → 后跑，被 stopPropagation 挡掉
 *
 * 打分规则：主轴距离为主；与当前元素在交叉轴上**有重叠**的优先（正对着的更符合直觉），
 * 没重叠的加大惩罚，避免「按一下 ↓ 跳到屏幕另一头」。
 */

import { topOverlay } from './overlay';

/** 参与导航的候选元素 */
const CANDIDATE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[tabindex]',
    '[role="slider"]',
    '[contenteditable="true"]',
].join(',');

/** 这些元素自己吃方向键（光标 / 取值语义） */
const OWN_ARROW_SELECTOR =
    'input, textarea, select, [contenteditable="true"], [role="slider"], [data-roving-ignore]';

type Direction = 'up' | 'down' | 'left' | 'right';

const KEY_TO_DIRECTION: Record<string, Direction | undefined> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

/** 元素现在是不是真的可见、可聚焦 */
function isVisibleFocusable(el: HTMLElement): boolean {
    // 注意：**不能**用 `tabIndex < 0` 作为过滤条件 —— 焦点组（useRovingFocus）会把组内
    // 非活动项都设成 -1，那正是方向键要移动过去的目标。真正要排除的"看不见的停靠点"
    // （收起的气泡面板里的滑条 / 音质选项）由下面的 opacity 检查负责。
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[inert]')) return false;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // 收起的浮层（气泡面板 opacity: 0）里的元素不算
    for (let p: HTMLElement | null = el; p; p = p.parentElement) {
        if (parseFloat(getComputedStyle(p).opacity) === 0) return false;
    }
    return true;
}

/** 收集候选：焦点在浮层里时只在那一层里找（弹窗 / 全屏页里不该跳到外面去） */
function collectCandidates(current: HTMLElement): HTMLElement[] {
    const topElement = topOverlay()?.element() ?? null;
    const scope: ParentNode = topElement && topElement.contains(current) ? topElement : document;
    return Array.from(scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).filter(
        isVisibleFocusable,
    );
}

/** 按几何位置找那个方向上最合适的元素 */
function findNext(
    current: HTMLElement,
    direction: Direction,
    candidates: HTMLElement[],
): HTMLElement | null {
    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const vertical = direction === 'up' || direction === 'down';

    let best: HTMLElement | null = null;
    let bestScore = Infinity;

    for (const el of candidates) {
        if (el === current || el.contains(current)) continue;

        const r = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - cx;
        const dy = r.top + r.height / 2 - cy;

        // 主轴上必须有位移，且确实在按下的那个方向
        const primary =
            direction === 'up' ? -dy : direction === 'down' ? dy : direction === 'left' ? -dx : dx;
        if (primary <= 1) continue;

        // 交叉轴上有重叠 = 正对着，优先
        const overlaps = vertical
            ? !(r.right < cr.left || r.left > cr.right)
            : !(r.bottom < cr.top || r.top > cr.bottom);
        const cross = vertical ? Math.abs(dx) : Math.abs(dy);

        const score = primary + (overlaps ? cross * 0.1 : 10000 + cross);
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }

    return best;
}

function onKeyDown(e: KeyboardEvent): void {
    const direction = KEY_TO_DIRECTION[e.key];
    if (!direction) return;
    // 元素自己处理过了（滑条调值、音质选项移动、输入框光标…）
    if (e.defaultPrevented) return;
    // 带修饰键的是快捷键的活
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || current === document.body) return;
    if (current.closest(OWN_ARROW_SELECTOR)) return;

    const next = findNext(current, direction, collectCandidates(current));
    // 这个方向上没有目标 → 不拦，留给快捷键
    if (!next) return;

    e.preventDefault();
    e.stopPropagation();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

let listening = false;

/** 挂上方向键空间导航（幂等）。在 mainWindow bootstrap 里调用一次。 */
export function setupSpatialFocus(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    document.addEventListener('keydown', onKeyDown);
}
