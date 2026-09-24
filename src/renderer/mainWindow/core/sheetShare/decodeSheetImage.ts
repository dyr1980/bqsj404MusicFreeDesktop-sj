/**
 * 从图片文件中解码歌单（二维码读取端）
 *
 * 刻意不用相机：桌面端的典型场景是「朋友发来一张长图 / 从网页保存了一张长图」，
 * 所以主入口是「选择本地图片」和「剪贴板里的图片」。
 *
 * 解码器选型：zxing-wasm（ZXing-C++ 的 WASM 构建，MIT）。
 * 实测同一批由长图生成的真实片段（390~981 字节，264~594px）：
 *   jsQR        14/21 可读，约 100 模块的码在 4+ 像素/模块时仍会失败
 *   zxing-wasm  21/21 可读，264px（2.5 像素/模块）也能稳定读出
 * 差距主要来自 zxing 的 tryHarder / 多码识别 / 下采样扫描。
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm';
import { SheetFragmentCollector, type DecodeFragmentResult, type SheetLike } from './codec';

export type DecodeImageOutcome =
    | {
          status: 'ok';
          payload: SheetLike;
          /** 识别到的二维码数量 */
          found: number;
      }
    | {
          status: 'incomplete';
          received: number;
          total: number;
          found: number;
          /** 还缺哪些段（从 1 开始），最多列 20 个 */
          missing: number[];
      }
    | {
          status: 'image_too_large';
          /** 图片像素数 */
          pixels: number;
          /** 允许的像素上限 */
          maxPixels: number;
      }
    | {
          status: 'no_qrcode';
          /** 实际尝试的识别次数，便于排查 */
          attempts: number;
          /** 尝试过的倍率，便于排查 */
          triedScales: number[];
      };

/**
 * 单次解码允许的最大像素数。
 *
 * 分享场景的主力输入就是「别人发来的长截图」（1080×8000 很常见），
 * 一张图在 scale=1 下就要分配 ~35MB RGBA，getImageData 还会再复制一份。
 * 这里给出预算而不是固定边长上限：小图可以放大，大图只能按 1x 处理。
 */
const MAX_PIXELS = 24_000_000;
/** 单边像素上限（Chromium 的 canvas 上限是 32767，留出余量） */
const MAX_EDGE = 16384;

/** 扫描倍率；实际用到的倍率还要过一遍像素预算 */
const CANDIDATE_SCALES = [1, 1.5, 2];

/** 从 File / Blob 读取为 dataURL */
export function readFileAsDataUrl(file: File | Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(`${reader.result}`);
        reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
        reader.readAsDataURL(file);
    });
}

// ────────────────────────────────────────────────────────────────────────────
// zxing 初始化
// ────────────────────────────────────────────────────────────────────────────

let zxingReady: Promise<void> | null = null;

/**
 * 初始化 zxing 的 WASM 模块。
 *
 * wasm 由 webpack 打成静态资源，这里 fetch 成 ArrayBuffer 交给 zxing 实例化，
 * 不走默认的 jsDelivr CDN。初始化失败会清掉缓存，允许下次重试。
 */
function ensureZXing(): Promise<void> {
    if (!zxingReady) {
        zxingReady = (async () => {
            const response = await fetch(wasmUrl);
            const wasmBinary = await response.arrayBuffer();
            await prepareZXingModule({
                overrides: { wasmBinary },
                fireImmediately: true,
            });
        })().catch((e) => {
            zxingReady = null;
            throw e;
        });
    }
    return zxingReady;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('图片解码失败'));
        image.src = dataUrl;
    });
}

/** 按像素预算把倍率收敛到一个可用值；返回 null 表示这张图根本放不下 */
function resolveScale(image: HTMLImageElement, wantedScale: number): number | null {
    const pixels = image.naturalWidth * image.naturalHeight;
    if (!pixels) {
        return null;
    }
    // 不放大：从目标倍率逐档降到能放下为止
    let scale = wantedScale;
    while (scale > 1) {
        const w = image.naturalWidth * scale;
        const h = image.naturalHeight * scale;
        if (w * h <= MAX_PIXELS && w <= MAX_EDGE && h <= MAX_EDGE) {
            return scale;
        }
        scale = scale - 0.25;
    }
    // 兜底 1x：只有连 1x 都超过单边上限才算放不下
    if (image.naturalWidth <= MAX_EDGE && image.naturalHeight <= MAX_EDGE) {
        return 1;
    }
    return null;
}

/** 把图片按指定倍率画到离屏 canvas 上；放不下时返回 null */
function makeScaledCanvas(image: HTMLImageElement, scale: number): HTMLCanvasElement | null {
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
        return null;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            return null;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, width, height);
        return canvas;
    } catch {
        return null;
    }
}

/**
 * 一次 zxing 调用就能拿到图里所有二维码（默认 maxNumberOfSymbols = 255），
 * 所以不需要自己切块或递归扫描。
 */
async function readAllQrCodes(canvas: HTMLCanvasElement): Promise<string[]> {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        return [];
    }
    let imageData: ImageData;
    try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
        // 画布被跨域图片污染
        return [];
    }

    // 像素已复制进 imageData，先把 canvas 释放掉再跑识别，避免大图多占一份 RGBA 缓冲。
    // 注意顺序：必须在 getImageData 之后，否则会拿到空画布。
    canvas.width = 0;
    canvas.height = 0;

    const results = await readBarcodes(imageData, {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        // 必须是 Plain：默认的 HRI 模式会把控制字符渲染成 <GS>/<US>/<RS> 字面量，
        // 而 v2 的片段正文用 U+001D/1E/1F 做分隔符，HRI 模式会直接破坏解析。
        textMode: 'Plain',
    });

    return results
        .filter((result) => result.isValid && result.text)
        .map((result) => result.text.trim());
}

/**
 * 从一张图片里识别并拼装歌单。
 *
 * @param dataUrl 图片的 dataURL
 */
export async function decodeSheetFromImageDataUrl(dataUrl: string): Promise<DecodeImageOutcome> {
    await ensureZXing();

    let image: HTMLImageElement;
    try {
        image = await loadImage(dataUrl);
    } catch {
        return { status: 'no_qrcode', attempts: 0, triedScales: [] };
    }

    const collector = new SheetFragmentCollector();
    const seen = new Set<string>();
    const triedScales: number[] = [];
    let found = 0;
    let attempts = 0;
    let blockedBySize = false;

    const feed = (strings: string[]): DecodeFragmentResult | null => {
        let last: DecodeFragmentResult | null = null;
        for (const data of strings) {
            if (seen.has(data)) {
                continue;
            }
            seen.add(data);
            const result = collector.push(data);
            if (result.status === 'error') {
                continue;
            }
            found += 1;
            last = result;
        }
        return last;
    };

    let last: DecodeFragmentResult | null = null;

    for (const wanted of CANDIDATE_SCALES) {
        const scale = resolveScale(image, wanted);
        if (scale === null) {
            // 图片本身超过单边上限，任何倍率都放不下
            blockedBySize = true;
            continue;
        }
        // 已经按某个倍率扫过就不重复扫（例如预算把 1.5 和 2 都压到了 1）
        if (triedScales.includes(scale)) {
            continue;
        }

        const canvas = makeScaledCanvas(image, scale);
        if (!canvas) {
            // 单张放不下就跳过这个倍率，不能 break——否则会漏掉后续倍率
            blockedBySize = true;
            continue;
        }

        triedScales.push(scale);
        attempts += 1;

        let strings: string[] = [];
        try {
            strings = await readAllQrCodes(canvas);
        } catch {
            strings = [];
        }
        // canvas 已由 readAllQrCodes 内部释放，这里不再重复处理

        const result = feed(strings);
        if (result) {
            last = result;
        }

        if (last?.status === 'ok') {
            return { status: 'ok', payload: last.payload, found };
        }
    }

    if (collector.totalCount > 0) {
        return {
            status: 'incomplete',
            received: collector.received,
            total: collector.totalCount,
            found,
            missing: collector.missingIndexes().slice(0, 20),
        };
    }

    if (blockedBySize && !attempts) {
        // 一次都没扫成，且原因是尺寸守卫，如实告诉用户而不是谎报"没有二维码"
        return {
            status: 'image_too_large',
            pixels: image.naturalWidth * image.naturalHeight,
            maxPixels: MAX_PIXELS,
        };
    }

    return { status: 'no_qrcode', attempts, triedScales };
}
