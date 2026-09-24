/**
 * 默认封面位图（不透明）—— 给系统媒体控件用
 *
 * 场景：Windows 音量浮层里的媒体卡片（SMTC）需要一张**图片 URL** 当缩略图。
 *   - 有网络封面时直接给封面 URL（受「设置 → 常规 → 封面加载」开关约束）
 *   - 没有封面、或开关被关掉时，**播放器界面显示的是默认封面**，系统媒体控件也应该显示同一张，
 *     而不是留空（留空时 Windows 会退回去显示应用名，看起来像"信息缺失"）
 *
 * 为什么要合成而不是直接用 `res/default-cover.png`：
 *   那张图是「黑墨 + 透明底」的 alpha mask（渲染层靠 CSS mask + currentColor 染色，
 *   见 `DefaultCover.tsx`）。CSS 渲染的结果没法交给系统媒体控件；而 mask 原图直接传过去是
 *   「黑墨 + 透明底」——在 Windows 的深色浮层里等于看不见。
 *   所以这里用 canvas 把「底色 + 墨迹」合成为一张**不透明** PNG（data URL）。
 *
 *   合成逻辑与主进程 `main/core/coverBitmap.ts` 的 `toDefaultCoverBitmap()` 一致，
 *   只是那边用 sharp、这边用 canvas —— 保证托盘 / 任务栏缩略图 / 系统媒体控件三处看到的是同一张图。
 *
 * 配色取自当前主题的 CSS 变量：
 *   - 底色 `--color-bg-placeholder`
 *   - 墨迹 `--color-text-muted`
 *   按配色缓存；主题切换后再次调用会自动重新合成。
 */
import defaultCoverMask from '@res/default-cover.png';

/** 合成尺寸：系统媒体控件的缩略图通常按 100~300px 显示，512 足够清晰又不至于太大 */
const SIZE = 512;

/** 拿不到主题变量时的兜底（与应用默认暗色主题一致） */
const FALLBACK_BG = '#27272a';
const FALLBACK_INK = 'rgba(255, 255, 255, 0.6)';

let cachedKey = '';
let cachedUrl: string | null = null;
let inflight: Promise<string> | null = null;

function currentPalette(): { bg: string; ink: string; key: string } {
    let bg = '';
    let ink = '';
    try {
        const cs = getComputedStyle(document.documentElement);
        bg = cs.getPropertyValue('--color-bg-placeholder').trim();
        ink = cs.getPropertyValue('--color-text-muted').trim();
    } catch {
        // 取不到就用兜底色
    }
    const finalBg = bg || FALLBACK_BG;
    const finalInk = ink || FALLBACK_INK;
    return { bg: finalBg, ink: finalInk, key: `${finalBg}|${finalInk}` };
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('default cover mask load failed'));
        img.src = src;
    });
}

/**
 * 合成「不透明默认封面」并返回 data URL。
 *
 * 同一套配色只会合成一次（缓存）；配色变了会自动重做。
 */
export async function getDefaultCoverDataUrl(): Promise<string> {
    const { bg, ink, key } = currentPalette();
    if (cachedUrl && cachedKey === key) return cachedUrl;
    if (inflight && cachedKey === key) return inflight;

    cachedKey = key;
    inflight = (async () => {
        const img = await loadImage(defaultCoverMask);
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');

        // 1) 先铺满墨迹色
        ctx.fillStyle = ink;
        ctx.fillRect(0, 0, SIZE, SIZE);
        // 2) 用 mask 的 alpha 裁出墨迹形状（黑墨=实、淡墨=半透明）
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        // 3) 在墨迹下面垫一层不透明底色
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.globalCompositeOperation = 'source-over';

        cachedUrl = canvas.toDataURL('image/png');
        inflight = null;
        return cachedUrl;
    })();

    try {
        return await inflight;
    } catch (e) {
        inflight = null;
        throw e;
    }
}

/** 已经合成好的默认封面（还没合成完则为 null）—— 供同步路径直接取用 */
export function getCachedDefaultCover(): string | null {
    return cachedUrl;
}

/** 预热：启动时调用一次，避免第一次切歌时才去合成 */
export function preloadDefaultCover(): void {
    void getDefaultCoverDataUrl().catch(() => {
        // 合成失败不影响播放，只是系统媒体控件少一张缩略图
    });
}
