/**
 * focusRing — 焦点环的「进入键盘导航」门控
 *
 * 需求：**连按 3 次 Tab 才出现焦点环**（第 1、2 次按 Tab 不显示）。
 * 目的是避免随手按一下 Tab（或误触）就闪出一圈环，只有用户明显在键盘导航时才提示。
 *
 * 计数按键：Tab 与方向键 / Home / End —— 方向键现在也会移动焦点（core/spatialFocus），
 * 只数 Tab 的话用方向键导航时焦点会在前两次"隐形移动"，所以统一的规则是
 * **任意 3 次键盘导航按键之后开始显示环**（连按 3 次 Tab 当然也算）。
 *
 * 实现方式是给 `<html>` 打标记，而不是去改那 40 多处组件里的焦点环规则：
 *   - 进入键盘导航 → `data-focus-ring="on"` → `--focus-ring-width` 恢复 3px
 *   - 否则 → 移除标记 → global.scss 里 `:root:not([data-focus-ring='on'])`
 *     把 `--focus-ring-width` 归零，全站焦点环（以及字号步进器那种内描边）一起消失
 *
 * 收回（回到「未进入键盘导航」）的时机：
 *   - 鼠标按下（用了鼠标就说明不是在键盘导航）
 *   - 按 Esc（Esc 的第一层语义就是退出焦点状态，见 core/overlay）
 *   - 窗口失焦
 *
 * 计数只在导航键上累加（中间按别的键不清零）；按 Esc / 用鼠标才清零。
 */

/** 连按多少次键盘导航键后开始显示焦点环 */
const ARM_AFTER_TAB_PRESSES = 3;

/** 计入「键盘导航」的按键：Tab 与方向键（方向键同样会移动焦点，不显示环就是隐形移动） */
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** 挂在 <html> 上的标记名 */
const ROOT_ATTR = 'data-focus-ring';

let tabPresses = 0;
let armed = false;
let listening = false;

function applyArm(next: boolean): void {
    if (armed === next) return;
    armed = next;
    const root = document.documentElement;
    if (next) {
        root.setAttribute(ROOT_ATTR, 'on');
    } else {
        root.removeAttribute(ROOT_ATTR);
    }
}

/** 退出键盘导航状态（并清零 Tab 计数） */
function reset(): void {
    tabPresses = 0;
    applyArm(false);
}

function onKeyDown(e: KeyboardEvent): void {
    if (NAV_KEYS.has(e.key)) {
        tabPresses += 1;
        if (tabPresses >= ARM_AFTER_TAB_PRESSES) {
            applyArm(true);
        }
        return;
    }
    if (e.key === 'Escape') {
        reset();
    }
}

/** 挂上门控（幂等）。在 mainWindow bootstrap 里调用一次。 */
export function setupFocusRing(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;

    // 捕获阶段：Tab 可能被别处 stopPropagation，这里必须都能记上
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', reset, true);
    window.addEventListener('blur', reset);
}
