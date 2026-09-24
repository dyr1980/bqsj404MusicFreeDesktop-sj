/**
 * 歌单分享长图渲染
 *
 * 设计：长图承担"给人看"的职责，二维码承担"给机器读"的职责，两者在同一张图里。
 *
 * 渲染分两趟，避免"二维码画在 canvas 上又被整体截图"这类坑：
 *   1. 文字部分（封面 / 歌单信息 / 歌曲列表）交给 DOM 排版，用 modern-screenshot
 *      转成 canvas，这样中文字体、省略号、换行全部由浏览器排版引擎处理；
 *   2. 二维码部分单独画在一张条带上，再贴到主 canvas 底部。二维码格子的
 *      offsetTop / offsetHeight 决定条带需要预留多高、每张码贴在哪里。
 *
 * 封面图走跨域 URL，绝大多数音乐平台的图片没有开放 CORS，会污染 canvas。
 * 因此封面加载失败/超时一律回退到渐变占位，保证长图永远能出。
 */
import QRCode from 'qrcode';
import { domToCanvas } from 'modern-screenshot';
import logger from '@infra/logger/renderer';
import {
    buildSheetDeeplink,
    encodeSheet,
    FRAGMENT_BYTE_LIMIT,
    type IEncodedFragment,
    type SheetLike,
} from './codec';

/** 画布宽度上限（CSS 像素）。实际宽度由 CONTENT_WIDTH 决定，见下 */
const IMAGE_WIDTH = 660;
/** 输出倍率，2 表示 2 倍像素密度 */
const IMAGE_SCALE = 2;
/** 画布内边距（CSS 像素）。收紧过：原来上下 40/32、左右 40，留白偏多 */
const PAGE_PADDING_X = 21;
const PAGE_PADDING_TOP = 20;
const PAGE_PADDING_BOTTOM = 16;

/** 单张长图最多渲染多少首（超出只影响展示，二维码仍含完整数据） */
const MAX_SONGS_PER_IMAGE = 150;

/** 封面边长（CSS 像素），与歌单信息同一行 */
const COVER_SIZE = 76;

/**
 * 单张长图最多画多少个二维码。
 *
 * 这个上限来自实测：码数量越多，识别越容易漏（zxing 在同一张图里找码时，
 * 密集排布会互相干扰）。实测 24 个以内可稳定识别。
 *
 * 注意：本图二维码不含"整份歌单"时，页脚必须如实说明——否则长歌单会静默缺歌。
 */
const MAX_QR_PER_IMAGE = 24;

/**
 * 二维码单元格边长（CSS 像素）与每行列数。
 *
 * 这两个值由读取端实测决定，**不要凭直觉调小**：
 * - 决定成败的是「设备像素 / 模块数」。实测（4 种倍率 × 4 种尺寸 × 3 档缩放）：
 *   只有 159px @2x（318 设备像素 = 2.50 px/模块）能同时通过「原图」与「缩 70%」；
 *   其余组合要么原图读不出，要么转发一次就丢码。缩到 50% 时 0 个组合可读。
 *   也就是说这里已经没有余量了。
 * - **112 CSS px 是「载荷相关坏点」**：同样载荷 100% 读不出，600 字节却正常。
 */
const QR_LAYOUT_SMALL = { cell: 159, columns: 3 } as const;
const QR_LAYOUT_DENSE = { cell: 150, columns: 3 } as const;

/** 超过这个码数就切到紧凑排布 */
const QR_DENSE_THRESHOLD = 6;
/** 二维码之间的间距 */
const QR_GAP = 8;

/** 某个布局下二维码区域的总宽度（含间距） */
function qrBlockWidth(layout: { cell: number; columns: number }): number {
    return layout.columns * layout.cell + (layout.columns - 1) * QR_GAP;
}

/**
 * 正文内容宽度 = 二维码区域宽度，两者左右对齐。
 *
 * 否则歌单列表用满整页宽度、二维码只占中间一截，视觉上不齐。
 * 取两种布局里的较大者，并保证不超过画布可用宽度。
 */
export const CONTENT_WIDTH = Math.min(
    Math.max(qrBlockWidth(QR_LAYOUT_SMALL), qrBlockWidth(QR_LAYOUT_DENSE)),
    IMAGE_WIDTH - PAGE_PADDING_X * 2,
);

/** 封面允许的最大像素数，超过就先缩放再转 dataURL（避免超大图白占一块 canvas） */
const MAX_ARTWORK_PIXELS = 4_000_000;
/** 封面单边上限 */
const MAX_ARTWORK_EDGE = 4096;

const FONT_STACK =
    '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", ' +
    '"Noto Sans CJK SC", "WenQuanYi Micro Hei", system-ui, -apple-system, "Segoe UI", sans-serif';

export interface IRenderSheetImageOptions {
    sheet: SheetLike;
    /** 单码字节上限，歌单越长每码装得越少；默认使用 codec 的推荐值 */
    fragmentByteLimit?: number;
    /** 页脚署名 */
    footerText?: string;
    /** 分类标签，如「本地歌单」 */
    platformLabel?: string;
    /**
     * 输出格式。
     *
     * - png：无损、文字最锐利，但二维码区域是高频噪点，PNG 几乎压不动（约 1.5MB/122 首）
     * - jpeg：体积约省 40~60%，二维码仍可解码（实测 q90 起全部可读）
     * - webp：体积最小（约省 60~70%），Electron 40 支持
     */
    format?: 'png' | 'jpeg' | 'webp';
    /** 有损格式质量 0~1，仅对 jpeg/webp 生效 @default 0.92 */
    quality?: number;
}

export interface IRenderedSheetImage {
    /** 最终长图的 dataURL */
    dataUrl: string;
    /** 实际使用的格式 */
    format: 'png' | 'jpeg' | 'webp';
    /** 编码后的字节数（用于展示体积） */
    byteSize: number;
    width: number;
    height: number;
    /** 本次编码出的片段（完整歌单） */
    fragments: IEncodedFragment[];
    /** 片段总数 */
    total: number;
    /** 实际画进图里的二维码数量（可能小于 total） */
    renderedQrCount: number;
    /** 是否因为歌单过长而做了截断（图片展示或二维码任一被截断） */
    truncated: boolean;
    /** 深链（单片段时自包含数据，多片段时只带总数） */
    deeplink: string;
}

function resolveQrLayout(qrCount: number) {
    return qrCount > QR_DENSE_THRESHOLD ? QR_LAYOUT_DENSE : QR_LAYOUT_SMALL;
}

function escapeHtml(input: string | undefined | null): string {
    return `${input ?? ''}`
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 尝试加载封面并转成 dataURL；跨域或超时都返回 null */
async function loadArtwork(url?: string, timeout = 4000): Promise<string | null> {
    if (!url) {
        return null;
    }
    return new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        const timer = setTimeout(() => {
            image.src = '';
            resolve(null);
        }, timeout);
        image.onload = () => {
            clearTimeout(timer);
            try {
                const naturalWidth = image.naturalWidth;
                const naturalHeight = image.naturalHeight;
                if (!naturalWidth || !naturalHeight) {
                    resolve(null);
                    return;
                }

                // 超大封面先等比缩到预算内，否则 canvas 分配可能失败或直接 OOM
                const ratio = Math.min(
                    1,
                    MAX_ARTWORK_EDGE / Math.max(naturalWidth, naturalHeight),
                    Math.sqrt(MAX_ARTWORK_PIXELS / (naturalWidth * naturalHeight)),
                );
                const width = Math.max(1, Math.round(naturalWidth * ratio));
                const height = Math.max(1, Math.round(naturalHeight * ratio));

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(image, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            } catch {
                // 画布被跨域图片污染等
                resolve(null);
            }
        };
        image.onerror = () => {
            clearTimeout(timer);
            resolve(null);
        };
        image.src = url;
    });
}

/** 由歌单标题生成一个稳定的渐变占位色 */
function placeholderGradient(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; ++i) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    return `linear-gradient(135deg, hsl(${hue}, 62%, 58%), hsl(${(hue + 48) % 360}, 68%, 44%))`;
}

/** 列数与列间距（CSS 像素），全部固定宽度以避免克隆时测量漂移 */
const COLUMN_COUNT = 2;
const COLUMN_GAP = 12;
const COLUMN_WIDTH = Math.floor((CONTENT_WIDTH - COLUMN_GAP * (COLUMN_COUNT - 1)) / COLUMN_COUNT);

/**
 * 歌曲行内的序号列。
 *
 * 宽度按「序号最大位数」自适应（12px 数字约 7px/位）：
 * 十几首歌时不留无用空白，几百首时也不会把 3 位数裁掉。
 * 对齐用居中而非右对齐——右对齐会把个位数顶到列最右侧，左侧空一大截，
 * 看起来就像整个列表缩进了。
 */
const DIGIT_WIDTH = 7;
/** 序号列右侧与歌名之间的固定间距 */
const SONG_ROW_GAP = 6;

const cellTextStyle = [
    'display:inline-block',
    'vertical-align:bottom',
    'overflow:hidden',
    'white-space:nowrap',
    'text-overflow:ellipsis',
].join(';');

/** 渲染一行歌曲；indexWidth / titleWidth / artistWidth 由调用方按歌单规模算好 */
function renderSongCell(
    index: number,
    title: string,
    artist: string,
    indexWidth: number,
    titleWidth: number,
    artistWidth: number,
): string {
    return `
        <div style="width:${COLUMN_WIDTH}px;height:21px;line-height:21px;white-space:nowrap;overflow:hidden;">
            <span style="display:inline-block;width:${indexWidth}px;text-align:center;color:#a8adb8;font-size:12px;font-variant-numeric:tabular-nums;">${
                index + 1
            }</span>
            <span style="${cellTextStyle};width:${titleWidth}px;margin-left:${SONG_ROW_GAP}px;color:#20242c;font-size:13px;">${escapeHtml(
                title,
            )}</span>
            <span style="${cellTextStyle};width:${artistWidth}px;color:#8a909c;font-size:12px;">${escapeHtml(
                artist,
            )}</span>
        </div>`;
}

/**
 * 歌曲清单相对内容左边界的额外左移量（CSS 像素）。
 *
 * 光靠内边距对齐还不够：数字列是「不可见」的，数字左边缘比封面/二维码的
 * 占位框看起来更靠右，视觉上像是缩进了。这里让清单单独向左探出一点，
 * 用一点负 margin 换取视觉齐平（列表左边缘比封面/二维码再靠左 3px）。
 */
const SONG_LIST_OFFSET = -3;

/** 构建文字部分的 DOM（不含二维码图形，只留占位区块用于测高） */
function buildFlyerDom(
    sheet: SheetLike,
    artworkDataUrl: string | null,
    fragments: IEncodedFragment[],
    totalFragments: number,
    songListTruncated: boolean,
    options: IRenderSheetImageOptions,
): HTMLDivElement {
    const musicList = sheet.musicList ?? [];
    const rendered = musicList.slice(0, MAX_SONGS_PER_IMAGE);
    const perColumn = Math.max(1, Math.ceil(rendered.length / COLUMN_COUNT));

    // 序号列宽度按最大序号的位数自适应：少歌不加空白，多歌不裁数字
    const maxIndexWidth = Math.max(1, String(rendered.length).length) * DIGIT_WIDTH;
    const textWidth = Math.max(40, COLUMN_WIDTH - maxIndexWidth - SONG_ROW_GAP);
    const titleWidth = Math.round(textWidth * 0.55);
    const artistWidth = textWidth - titleWidth;

    const columnsHtml = Array.from({ length: COLUMN_COUNT }, (_, c) => {
        const slice = rendered.slice(c * perColumn, (c + 1) * perColumn);
        return `<div style="width:${COLUMN_WIDTH}px;flex:0 0 ${COLUMN_WIDTH}px;">${slice
            .map((song, i) =>
                renderSongCell(
                    c * perColumn + i,
                    song?.title ?? '',
                    song?.artist ?? '',
                    maxIndexWidth,
                    titleWidth,
                    artistWidth,
                ),
            )
            .join('')}</div>`;
    }).join('');

    const qrCount = Math.min(fragments.length, MAX_QR_PER_IMAGE);
    const qrLayout = resolveQrLayout(qrCount);
    const qrCellsHtml = fragments
        .slice(0, qrCount)
        .map(
            () => `
        <div data-qr-block="true" style="width:${qrLayout.cell}px;flex:0 0 ${qrLayout.cell}px;">
            <div data-qr-cell="true" style="width:${qrLayout.cell}px;height:${qrLayout.cell}px;box-sizing:border-box;background:#fff;border:1px solid #e6e8ee;border-radius:6px;"></div>
        </div>`,
        )
        .join('');

    // 分段编号单独成行放在二维码下方。
    // 千万不要把编号放进格子内部：那样二维码必须缩小让位，
    // 设备像素会从 264 掉到 ~208，掉到解码器临界点以下（实测 1x 完全读不出）。
    const qrLabelsHtml = `<div style="display:flex;flex-wrap:wrap;gap:${QR_GAP}px;margin-top:3px;">${fragments
        .slice(0, qrCount)
        .map(
            (fragment) =>
                `<div data-qr-label-row="true" style="width:${qrLayout.cell}px;flex:0 0 ${qrLayout.cell}px;text-align:center;font-size:10px;line-height:14px;color:#8a909c;">第 ${fragment.index}/${fragment.total} 段</div>`,
        )
        .join('')}</div>`;

    const overflows = totalFragments > MAX_QR_PER_IMAGE;

    const qrIntroHtml = overflows
        ? `用 MusicFree 扫描下方二维码可导入这份歌单（本图含前 ${qrCount}/${totalFragments} 段，<b>不完整</b>）`
        : qrCount > 1
          ? `用 MusicFree 扫描下方二维码即可导入这份歌单（共 ${totalFragments} 段，任意顺序扫齐即可）`
          : `用 MusicFree 扫描下方二维码即可导入这份歌单`;

    const root = document.createElement('div');
    root.style.cssText = [
        // 画布宽度 = 内容宽 + 左右留白，避免右侧多出一块空白
        `width:${CONTENT_WIDTH + PAGE_PADDING_X * 2}px`,
        'box-sizing:border-box',
        `padding:${PAGE_PADDING_TOP}px ${PAGE_PADDING_X}px ${PAGE_PADDING_BOTTOM}px`,
        'background:#ffffff',
        `font-family:${FONT_STACK}`,
        'position:absolute',
        'left:-99999px',
        'top:0',
    ].join(';');

    root.innerHTML = `
        <div style="display:flex;gap:16px;align-items:center;">
            <div style="flex:0 0 ${COVER_SIZE}px;width:${COVER_SIZE}px;height:${COVER_SIZE}px;border-radius:10px;overflow:hidden;background:${placeholderGradient(
                sheet.title ?? 'MusicFree',
            )};display:flex;align-items:center;justify-content:center;">
                ${
                    artworkDataUrl
                        ? `<img src="${artworkDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" />`
                        : `<span style="color:#fff;font-size:26px;font-weight:600;">${escapeHtml(
                              (sheet.title ?? 'M').trim().charAt(0) || 'M',
                          )}</span>`
                }
            </div>
            <div style="flex:1 1 auto;min-width:0;height:${COVER_SIZE}px;display:flex;flex-direction:column;justify-content:center;gap:4px;">
                <div style="font-size:20px;font-weight:700;color:#12151b;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(
                    sheet.title ?? '未命名歌单',
                )}</div>
                <div style="font-size:13px;color:#6b7280;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(
                    sheet.artist || '未知作者',
                )}</div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#4b5563;line-height:1.2;">
                    <span style="background:#f1f3f7;border-radius:999px;padding:2px 10px;">${
                        musicList.length
                    } 首歌</span>
                    ${
                        options.platformLabel
                            ? `<span style="background:#f1f3f7;border-radius:999px;padding:2px 10px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(
                                  options.platformLabel,
                              )}</span>`
                            : ''
                    }
                </div>
            </div>
        </div>

        <div style="margin-top:16px;margin-left:${SONG_LIST_OFFSET}px;display:flex;align-items:flex-start;gap:${COLUMN_GAP}px;">${columnsHtml}</div>

        ${
            songListTruncated
                ? `<div style="margin-top:14px;font-size:12px;color:#b45309;background:#fffbeb;border-radius:6px;padding:8px 12px;">为控制图片长度，本图只展示前 ${MAX_SONGS_PER_IMAGE} 首（数据完整，扫描二维码可导入全部）。</div>`
                : ''
        }

        <div style="margin-top:18px;border-top:1px solid #e8eaef;padding-top:12px;">
            <div style="font-size:13px;color:#4b5563;margin-bottom:10px;">
                ${qrIntroHtml}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:${QR_GAP}px;">${qrCellsHtml}</div>
            ${qrLabelsHtml}
            ${
                overflows
                    ? `<div style="margin-top:12px;font-size:12px;color:#b45309;background:#fffbeb;border-radius:6px;padding:8px 12px;">这份歌单需要 ${totalFragments} 段二维码，本图只画出了前 ${qrCount} 段，<b>仅靠这张图无法导入完整歌单</b>。完整数据请用分享面板里的「复制导入文本」发送给对方。</div>`
                    : ''
            }
        </div>

        <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#9aa0ac;">
            <span>${escapeHtml(options.footerText ?? 'MusicFree · 插件化免费音乐播放器')}</span>
            <span>${new Date().toLocaleDateString()}</span>
        </div>
    `;

    return root;
}

/** 把二维码画到离屏 canvas 上 */
async function createQrCanvases(
    fragments: IEncodedFragment[],
    size: number,
): Promise<HTMLCanvasElement[]> {
    return Promise.all(
        fragments.map(async (fragment) => {
            const canvas = document.createElement('canvas');
            await QRCode.toCanvas(canvas, fragment.fragment, {
                width: size,
                margin: 1,
                errorCorrectionLevel: 'L',
                color: {
                    dark: '#12151b',
                    light: '#ffffff',
                },
            });
            return canvas;
        }),
    );
}
/**
 * 用占位区块的实际位置，单独渲染一条只包含二维码的 canvas 条带。
 *
 * 只画二维码图形本身，不重复绘制文字：文字（歌单信息、歌曲列表、二维码下方标签）
 * 已经由 domToCanvas 渲染过了，这里只负责把清晰的矢量二维码**精确覆盖**到
 * 主画布底部对应的占位框上。
 *
 * 坐标全部按「设备像素」计算：条带左上角 = 第一个二维码格的左上角，
 * 高度/宽度取单元格自身的尺寸。这样条带内容与占位框严丝合缝，
 * 不会出现「占位框在上、二维码在下」的错位与重复占位。
 */
async function renderQrFooterCanvas(
    flyer: HTMLElement,
    qrCells: HTMLElement[],
    fragments: IEncodedFragment[],
): Promise<HTMLCanvasElement> {
    const flyerRect = flyer.getBoundingClientRect();

    const canvas = document.createElement('canvas');
    if (!qrCells.length) {
        canvas.width = Math.round((flyerRect.width || IMAGE_WIDTH) * IMAGE_SCALE);
        canvas.height = 0;
        return canvas;
    }

    const cellRects = qrCells.map((cell) => cell.getBoundingClientRect());
    const firstRect = cellRects[0];

    // 覆盖范围：二维码格子 + 其下方独立成行的编号
    let left = firstRect.left;
    let top = firstRect.top;
    let right = firstRect.right;
    let bottom = firstRect.bottom;
    for (const rect of cellRects) {
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
    }
    const labelRows = Array.from(flyer.querySelectorAll<HTMLElement>('[data-qr-label-row]'));
    for (const row of labelRows) {
        const rect = row.getBoundingClientRect();
        bottom = Math.max(bottom, rect.bottom);
    }
    // 单边各留 1px 余量，覆盖 1px 边框的齐边渲染
    const pad = 1;
    const stripLeftCss = left - pad;
    const stripTopCss = top - pad;
    const stripWidthCss = right - stripLeftCss + pad;
    const stripHeightCss = bottom - stripTopCss + pad;

    canvas.width = Math.round(stripWidthCss * IMAGE_SCALE);
    canvas.height = Math.round(stripHeightCss * IMAGE_SCALE);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('无法创建画布上下文');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cellDeviceSize = Math.round(qrCells[0].getBoundingClientRect().width * IMAGE_SCALE);
    const qrCanvases = await createQrCanvases(fragments, cellDeviceSize);

    qrCells.forEach((cell, index) => {
        const qrCanvas = qrCanvases[index];
        if (!qrCanvas) {
            return;
        }
        const rect = cellRects[index];
        // 相对条带左上角（=第一个格子左上角再往左上 pad 处）
        const x = (rect.left - stripLeftCss) * IMAGE_SCALE;
        const y = (rect.top - stripTopCss) * IMAGE_SCALE;
        const w = Math.round(rect.width * IMAGE_SCALE);
        const h = Math.round(rect.height * IMAGE_SCALE);

        // 先把整个格子刷白（覆盖 domToCanvas 画的空占位框），再画满格二维码。
        // 二维码必须画满：缩小会让设备像素/模块掉到解码临界点以下。
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, w, h);
        ctx.drawImage(qrCanvas, x, y, w, h);
    });

    return canvas;
}

/**
 * 渲染歌单分享长图。
 *
 * 会临时往 document.body 里挂一个离屏节点，渲染完成后立即移除。
 */
export async function renderSheetImage(
    options: IRenderSheetImageOptions,
): Promise<IRenderedSheetImage> {
    const { sheet } = options;
    let step = 'start';

    try {
        step = 'encode';
        const encoded = encodeSheet(sheet, options.fragmentByteLimit ?? FRAGMENT_BYTE_LIMIT);
        logger.info('[sheetShare] encoded', {
            songs: sheet.musicList?.length ?? 0,
            fragments: encoded.total,
            bytes: encoded.payloadByteLength,
        });

        step = 'artwork';
        const artworkDataUrl = await loadArtwork(sheet.artwork ?? sheet.coverImg);
        logger.info('[sheetShare] artwork', { hasArtwork: !!artworkDataUrl });

        const songListTruncated = (sheet.musicList?.length ?? 0) > MAX_SONGS_PER_IMAGE;
        const renderedQrCount = Math.min(encoded.fragments.length, MAX_QR_PER_IMAGE);

        step = 'buildDom';
        const flyer = buildFlyerDom(
            sheet,
            artworkDataUrl,
            encoded.fragments.slice(0, renderedQrCount),
            encoded.fragments.length,
            songListTruncated,
            options,
        );
        document.body.appendChild(flyer);

        try {
            // 等两帧，确保封面 dataURL 已解码（Image 对 dataURL 的解码是异步的）
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

            step = 'domToCanvas';
            const rect = flyer.getBoundingClientRect();
            logger.info('[sheetShare] flyer rect', {
                w: Math.round(rect.width),
                h: Math.round(rect.height),
            });
            const contentCanvas = await domToCanvas(flyer, {
                scale: IMAGE_SCALE,
                backgroundColor: '#ffffff',
                // 不下载/内嵌系统字体，中文交给本机字体渲染
                font: false,
            });
            logger.info('[sheetShare] content canvas', {
                w: contentCanvas.width,
                h: contentCanvas.height,
            });

            step = 'qrStrip';
            const qrCells = Array.from(flyer.querySelectorAll<HTMLElement>('[data-qr-cell]'));
            const qrFooterCanvas = await renderQrFooterCanvas(
                flyer,
                qrCells,
                encoded.fragments.slice(0, renderedQrCount),
            );
            // 条带左上角要覆盖到的位置：第一个二维码格子的左上角（相对 flyer 顶部）
            const qrStripTopCss = qrCells.length
                ? qrCells[0].getBoundingClientRect().top - flyer.getBoundingClientRect().top
                : 0;
            const qrStripLeftCss = qrCells.length
                ? qrCells[0].getBoundingClientRect().left - flyer.getBoundingClientRect().left
                : 0;
            logger.info('[sheetShare] qr strip', {
                cells: qrCells.length,
                w: qrFooterCanvas.width,
                h: qrFooterCanvas.height,
            });

            step = 'compose';
            const width = contentCanvas.width;
            // 内容画布只画到二维码格子上方，二维码由条带绘制，避免重复占位
            const contentBottom = Math.round(qrStripTopCss * IMAGE_SCALE);
            const stripTop = contentBottom;
            const totalHeight = stripTop + qrFooterCanvas.height;

            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = width;
            finalCanvas.height = totalHeight;
            const ctx = finalCanvas.getContext('2d');
            if (!ctx) {
                throw new Error('无法创建画布上下文');
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, totalHeight);
            ctx.drawImage(contentCanvas, 0, 0, width, contentBottom, 0, 0, width, contentBottom);
            ctx.drawImage(qrFooterCanvas, Math.round(qrStripLeftCss * IMAGE_SCALE), stripTop);

            step = 'toDataURL';
            const format = options.format ?? 'png';
            const quality = options.quality ?? 0.92;
            const mime =
                format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
            // JPEG 没有透明通道，但我们的画布已经铺了白底，直接编码即可
            const dataUrl =
                format === 'png'
                    ? finalCanvas.toDataURL('image/png')
                    : finalCanvas.toDataURL(mime, quality);

            const byteSize = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
            logger.info('[sheetShare] done', {
                w: width,
                h: totalHeight,
                format,
                kb: Math.round(byteSize / 1024),
            });

            return {
                dataUrl,
                format,
                byteSize,
                width,
                height: totalHeight,
                fragments: encoded.fragments,
                total: encoded.total,
                renderedQrCount,
                truncated: songListTruncated || encoded.fragments.length > renderedQrCount,
                deeplink: buildSheetDeeplink(encoded),
            };
        } finally {
            flyer.remove();
        }
    } catch (e) {
        // 分步日志：出错时能立刻定位是哪个环节挂的
        logger.error(
            `[sheetShare] render failed at step "${step}":`,
            e instanceof Error ? `${e.name}: ${e.message}` : e,
            e instanceof Error ? e.stack : undefined,
        );
        throw e;
    }
}

/** 供 UI 预估：这个歌单会生成几个二维码 */
export function previewFragmentCount(
    sheet: SheetLike,
    byteLimit: number = FRAGMENT_BYTE_LIMIT,
): number {
    return encodeSheet(sheet, byteLimit).total;
}
