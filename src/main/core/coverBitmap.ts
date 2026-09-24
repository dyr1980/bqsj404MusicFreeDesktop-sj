/**
 * coverBitmap — 主进程封面位图工具
 *
 * 托盘菜单（CustomTrayMenu）和任务栏缩略图（TaskbarManager）都要一张
 * 「歌曲封面 → N×N 原始像素」的位图，两边原本各写了一份完全相同的
 * sharp 转换（+ RGBA→BGRA 交换），这里合并成一份。
 *
 * 关于默认封面：`res/default-cover.png` 与渲染进程共用同一份素材
 * （见 renderer/common/DefaultCover），它是一张 **alpha mask**——
 * 只有墨迹形状、RGB 恒为黑、底色透明，颜色由渲染进程用 currentColor 染。
 * 主进程若把它原样交给原生模块，透明处会露出菜单底色、黑墨在深色菜单上
 * 等于看不见，所以这里用主题配色合成成一张不透明底图：
 *   - 底色 = `--color-bg-placeholder`
 *   - 墨迹 = `--color-text-muted`（含它的透明度）
 * 这两个值由渲染进程随主题切换事件上报（见 infra/themepack），
 * 拿不到时退回应用默认（暗色）主题的值。
 */

import type { ICoverPalette } from '@appTypes/infra/themepack';

/** 拿不到主题变量时的兜底配色 = 应用默认（暗色）主题 */
const FALLBACK_COVER_PALETTE: ICoverPalette = {
    bg: { r: 39, g: 39, b: 42 },
    ink: { r: 255, g: 255, b: 255, a: 0.6 },
};

/** 通道顺序：CustomTrayMenu 吃 BGRA32，TaskbarManager 吃 RGBA */
export type TCoverChannelOrder = 'rgba' | 'bgra';

/** 原始像素封面图 */
export interface ICoverBitmap {
    data: Buffer;
    width: number;
    height: number;
}

/** 当前配色（随主题变化） */
let coverPalette: ICoverPalette = FALLBACK_COVER_PALETTE;

/** 配色订阅者（托盘 / 任务栏缩略图需要按新配色重画默认封面） */
const paletteListeners = new Set<() => void>();

/** 判断两份配色是否一致（避免主题事件重复触发重画） */
function isSamePalette(a: ICoverPalette, b: ICoverPalette): boolean {
    return (
        a.bg.r === b.bg.r &&
        a.bg.g === b.bg.g &&
        a.bg.b === b.bg.b &&
        a.ink.r === b.ink.r &&
        a.ink.g === b.ink.g &&
        a.ink.b === b.ink.b &&
        a.ink.a === b.ink.a
    );
}

/**
 * 设置默认封面底图配色（渲染进程上报主题变量后由 themepack 层调用）。
 *
 * 传空表示「这次没读到主题变量」，保持当前配色不变——主题 CSS 还没生效时
 * 会先上报一次空值，这时不该把配色打回兜底值。
 */
export function setDefaultCoverPalette(palette?: ICoverPalette | null): void {
    if (!palette || isSamePalette(palette, coverPalette)) return;
    coverPalette = palette;
    for (const listener of paletteListeners) {
        try {
            listener();
        } catch {
            // 单个订阅者出错不影响其它订阅者
        }
    }
}

/** 订阅配色变化，返回取消订阅函数 */
export function onDefaultCoverPaletteChange(listener: () => void): () => void {
    paletteListeners.add(listener);
    return () => {
        paletteListeners.delete(listener);
    };
}

/** 当前配色（测试 / 调试用） */
export function getDefaultCoverPalette(): ICoverPalette {
    return coverPalette;
}

/** 就地交换 R / B 通道（RGBA ⇄ BGRA） */
function swapRedBlue(data: Buffer): void {
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        data[i] = data[i + 2];
        data[i + 2] = r;
    }
}

/** 图片 Buffer（jpeg/png/webp…）→ size×size 原始像素 */
export async function toCoverBitmap(
    buffer: Buffer,
    size: number,
    order: TCoverChannelOrder = 'rgba',
): Promise<ICoverBitmap> {
    const { default: sharp } = await import('sharp');
    const result = await sharp(buffer)
        .resize(size, size, { fit: 'cover' })
        .ensureAlpha(1)
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (order === 'bgra') {
        swapRedBlue(result.data);
    }

    return {
        data: result.data,
        width: result.info.width,
        height: result.info.height,
    };
}

/**
 * 默认封面（alpha mask）→ size×size 不透明底图。
 *
 * mask 的 RGB 全黑、形状只在 alpha 通道里，所以用它当作「墨迹」的透明度，
 * 与底色混合后写出不透明像素（浅色主题 = 浅底深墨，暗色主题 = 深底浅墨）。
 */
export async function toDefaultCoverBitmap(
    mask: Buffer,
    size: number,
    order: TCoverChannelOrder = 'rgba',
): Promise<ICoverBitmap> {
    const { default: sharp } = await import('sharp');
    const result = await sharp(mask)
        .resize(size, size, { fit: 'cover' })
        .ensureAlpha(1)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { bg, ink } = coverPalette;
    const data = result.data;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = (data[i + 3] / 255) * ink.a;
        data[i] = Math.round(bg.r * (1 - alpha) + ink.r * alpha);
        data[i + 1] = Math.round(bg.g * (1 - alpha) + ink.g * alpha);
        data[i + 2] = Math.round(bg.b * (1 - alpha) + ink.b * alpha);
        data[i + 3] = 255;
    }

    if (order === 'bgra') {
        swapRedBlue(data);
    }

    return {
        data,
        width: result.info.width,
        height: result.info.height,
    };
}
