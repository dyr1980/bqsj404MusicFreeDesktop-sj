/**
 * parseCssColor — 解析 CSS 颜色字符串
 *
 * 只覆盖主题变量里实际会用到的写法：#rgb / #rgba / #rrggbb / #rrggbbaa、
 * rgb() / rgba()（逗号或空格分隔、可带 %）。解析失败返回 null，
 * 调用方自己兜底（例如托盘底图退回内置默认配色）。
 */

/** 解析结果（0~255，alpha 0~1） */
export interface IRgbaColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** 单个通道：0~255 的数字或带 % 的字符串 */
function parseChannel(raw: string, max: number): number | null {
    const text = raw.trim();
    if (!text) return null;
    const isPercent = text.endsWith('%');
    const value = Number.parseFloat(isPercent ? text.slice(0, -1) : text);
    if (!Number.isFinite(value)) return null;
    const scaled = isPercent ? (value / 100) * max : value;
    return Math.max(0, Math.min(max, Math.round(scaled)));
}

/** alpha 通道：0~1 的数字或带 % 的字符串 */
function parseAlpha(raw: string | undefined): number {
    if (raw === undefined) return 1;
    const text = raw.trim();
    if (!text) return 1;
    const isPercent = text.endsWith('%');
    const value = Number.parseFloat(isPercent ? text.slice(0, -1) : text);
    if (!Number.isFinite(value)) return 1;
    const scaled = isPercent ? value / 100 : value;
    return Math.max(0, Math.min(1, scaled));
}

/**
 * 解析 CSS 颜色字符串。
 *
 * @param input 形如 `#fff`、`#ffffff80`、`rgb(39, 39, 42)`、`rgba(255, 255, 255, 0.6)`
 * @returns 解析结果；无法识别时返回 null
 */
export function parseCssColor(input?: string | null): IRgbaColor | null {
    if (!input) return null;
    const text = input.trim().toLowerCase();
    if (!text) return null;

    // ── #rgb / #rgba / #rrggbb / #rrggbbaa ──
    if (text.startsWith('#')) {
        const hex = text.slice(1);
        if (!/^[0-9a-f]+$/.test(hex)) return null;

        const expand = (ch: string) => Number.parseInt(ch + ch, 16);
        if (hex.length === 3 || hex.length === 4) {
            return {
                r: expand(hex[0]),
                g: expand(hex[1]),
                b: expand(hex[2]),
                a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
            };
        }
        if (hex.length === 6 || hex.length === 8) {
            return {
                r: Number.parseInt(hex.slice(0, 2), 16),
                g: Number.parseInt(hex.slice(2, 4), 16),
                b: Number.parseInt(hex.slice(4, 6), 16),
                a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }

    // ── rgb() / rgba() ──
    const fnMatch = text.match(/^rgba?\(([^)]*)\)$/);
    if (!fnMatch) return null;

    // 逗号或空白分隔（现代写法两种都有）
    const parts = fnMatch[1]
        .replace(/\//g, ' ')
        .split(/[\s,]+/)
        .filter(Boolean);
    if (parts.length < 3) return null;

    const r = parseChannel(parts[0], 255);
    const g = parseChannel(parts[1], 255);
    const b = parseChannel(parts[2], 255);
    if (r === null || g === null || b === null) return null;

    return { r, g, b, a: parseAlpha(parts[3]) };
}

export default parseCssColor;
