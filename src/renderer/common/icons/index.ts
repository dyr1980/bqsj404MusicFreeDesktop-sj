// ============================================================================
// 自定义图标 — 基于 createLucideIcon 扩展
// ============================================================================
//
// 本文件存放项目中 Lucide 官方库未提供的自定义图标。
// 所有图标遵循 Lucide 图标规范：
//   - viewBox: 0 0 24 24
//   - stroke: currentColor, strokeWidth: 2
//   - strokeLinecap: round, strokeLinejoin: round
//   - 不使用 fill（或 fill="none"）
//
// 创建的图标类型为 LucideIcon，与官方图标完全兼容，可直接使用
// <IconName size={20} /> 等 props。
//
// 新增图标步骤：
//   1. 在下方用 createLucideIcon(displayName, iconNode) 定义
//   2. iconNode 格式: [tagName, svgAttributes][]
//   3. 导出即可使用

import { createElement, type CSSProperties } from 'react';
import { createLucideIcon } from 'lucide-react';

// ─── DesktopLyric ───────────────────────────────────────────────────────────

// 桌面歌词图标：一个显示器轮廓内嵌歌词文字行，表达"桌面歌词"概念。
// 设计思路：
//   - 外层为简洁的显示器边框（圆角矩形 + 底座）
//   - 内层为两条水平线条，象征歌词文字
//   - 整体在 16px 下仍可辨识
export const DesktopLyric = createLucideIcon('DesktopLyric', [
    // 显示器外框
    [
        'rect',
        {
            x: '2',
            y: '3',
            width: '20',
            height: '14',
            rx: '2',
            ry: '2',
        },
    ],
    // 显示器底座支架
    ['line', { x1: '12', y1: '17', x2: '12', y2: '21' }],
    // 底座横杆
    ['line', { x1: '8', y1: '21', x2: '16', y2: '21' }],
    // 歌词行 1（较长）
    ['line', { x1: '6', y1: '8', x2: '18', y2: '8' }],
    // 歌词行 2（较短，居中）
    ['line', { x1: '8', y1: '12', x2: '16', y2: '12' }],
]);

// ─── MiniModeShrink / MiniModeExpand ────────────────────────────────────────
//
// 「迷你模式」的一对图标：圆角窗口 + 两条斜箭头。
//   - Shrink：箭头**指向窗口中心**（收缩成小窗）→ 进入迷你模式
//   - Expand：箭头**从中心指向外面**（把窗口撑开）→ 在迷你窗口里「展开主界面」
// 两者是同一个图形的正反方向，放在一起看就知道是「大 ⇄ 小」的同一件事。
//
// 箭头构造沿用 lucide 的 arrow-* 画法：一条斜杆 + 一个拐角箭头头部，
// 头部拐角落在箭尖上（如 arrow-down-right 的 `M17 7v10H7`）。
// 这里杆长 ~3.8、头臂 ~3.4，头部占比大一些，16px 下才不会糊成一点。
export const MiniModeShrink = createLucideIcon('MiniModeShrink', [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '4', ry: '4' }],
    // 左上：斜向中心（↘）
    ['path', { d: 'M7.2 7.2 11 11' }],
    ['path', { d: 'M11 7.6V11H7.6' }],
    // 右下：斜向中心（↖）
    ['path', { d: 'M16.8 16.8 13 13' }],
    ['path', { d: 'M13 16.4V13h3.4' }],
]);

export const MiniModeExpand = createLucideIcon('MiniModeExpand', [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '4', ry: '4' }],
    // 左上：斜向外（↖）
    ['path', { d: 'M11 11 7.2 7.2' }],
    ['path', { d: 'M7.2 10.4V7.2h3.2' }],
    // 右下：斜向外（↘）
    ['path', { d: 'M13 13l3.8 3.8' }],
    ['path', { d: 'M16.8 13.6v3.2h-3.2' }],
]);

// ─── TrayCollapse ───────────────────────────────────────────────────────────
//
// 「收至托盘」：斜向右下的箭头 + 一个实心圆点。
//   - 箭头是主体（拐角箭头头沿用 lucide arrow-* 的画法），点紧贴箭尖
//   - 点 = 窗口收进去之后的落点；点用 fill 的实心圆（描边圆在 14px 下会糊成空心圈）
// 之前的「开口托盘 + 向下箭头」跟标题栏的「最小化」区分度不够，换成这个更轻的画法。
export const TrayCollapse = createLucideIcon('TrayCollapse', [
    // 斜向右下的箭头（杆 + 拐角箭头头）
    ['path', { d: 'M4 4 12.4 12.4' }],
    ['path', { d: 'M12.4 8.4V12.4H8.4' }],
    // 落点（实心圆点）
    ['circle', { cx: '16.9', cy: '16.9', r: '1.9', fill: 'currentColor', stroke: 'none' }],
]);

// ─── LyricSettingsIcon ──────────────────────────────────────────────────────
// 「词」字图标：用作播放界面的歌词设置入口。
//
// 本文件是 .ts（不能用 JSX），所以这里用 createElement。
// 也刻意不用 createLucideIcon：它会把 stroke 等默认属性合并进来，
// 而汉字需要填充（描边会糊成一团），普通组件更好控制。
// 尺寸 / 颜色沿用 Lucide 约定（size 控制字号、currentColor 控制颜色）。
export function LyricSettingsIcon(props: {
    size?: number | string;
    className?: string;
    style?: CSSProperties;
    [key: string]: unknown;
}) {
    const { size = 16, className, style, ...rest } = props;
    const px = typeof size === 'number' ? `${size}px` : size;

    return createElement(
        'span',
        {
            className,
            'aria-hidden': true,
            style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: px,
                height: px,
                fontSize: `calc(${px} * 0.92)`,
                fontWeight: 700,
                lineHeight: 1,
                color: 'currentColor',
                userSelect: 'none',
                ...style,
            },
            ...rest,
        },
        '词',
    );
}
