/**
 * 歌单分享长图 —— 对外统一入口
 *
 * 三条分享路径共用同一套编解码：
 *   1. 生成长图（二维码内嵌）→ 给人看 + 给机器读
 *   2. 复制导入文本（片段文本）→ 走聊天窗口粘贴
 *   3. 深链 musicfree://importSheet?d=... → 直接唤起客户端
 *
 * 读取侧同样收敛到 decodeSharePayload：无论数据来自二维码图片、剪贴板文本，
 * 还是深链，最终都走这一个解码函数。
 */
import fsUtil from '@infra/fsUtil/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import {
    renderSheetImage,
    previewFragmentCount,
    type IRenderedSheetImage,
} from './renderSheetImage';
import {
    decodeSheetFromImageDataUrl,
    readFileAsDataUrl,
    type DecodeImageOutcome,
} from './decodeSheetImage';
import { decodeSheetFromText, type DecodeFragmentResult, type SheetLike } from './codec';

export * from './codec';
export { resolveLocalShareSheet, resolveRemoteShareSheet } from './resolveShareSheet';
export type { IRenderedSheetImage, DecodeImageOutcome };
export { decodeSheetFromImageDataUrl, readFileAsDataUrl, previewFragmentCount };
export { renderSheetImage };

type ImageFormat = 'png' | 'jpeg' | 'webp';

/** 各格式的扩展名与对话框里显示的说明 */
const FORMAT_META: Record<
    ImageFormat,
    { ext: string; filter: { name: string; extensions: string[] } }
> = {
    webp: {
        ext: 'webp',
        filter: { name: 'WebP 图片（体积最小）', extensions: ['webp'] },
    },
    jpeg: {
        ext: 'jpg',
        filter: { name: 'JPEG 图片（兼容性好）', extensions: ['jpg', 'jpeg'] },
    },
    png: {
        ext: 'png',
        filter: { name: 'PNG 图片（无损，体积最大）', extensions: ['png'] },
    },
};

/** 长图默认文件名，去掉文件系统非法字符 */
function buildDefaultFileName(title: string | undefined, ext: string): string {
    const safe = (title ?? '歌单')
        .replace(/[/\\?*"<>:|]+/g, '_')
        .slice(0, 40)
        .trim();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `${safe || '歌单'}-${stamp}.${ext}`;
}

/** base64 -> 字节数组（渲染进程是沙箱环境，没有 Node 的 Buffer） */
function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** dataURL -> 字节数组 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
    return base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
}

/** 由文件扩展名反推格式；无法识别时回退到默认格式 */
function formatFromPath(filePath: string, fallback: ImageFormat): ImageFormat {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'png') return 'png';
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'webp') return 'webp';
    return fallback;
}

/**
 * 渲染长图并让用户选择保存位置。
 *
 * 保存对话框的「文件类型」会跟随面板里选定的格式：把选中的格式排在第一位并默认选中，
 * 同时默认文件名用对应扩展名，避免出现「面板选 WebP、对话框默认 PNG」这种不一致。
 * 用户仍可在对话框里改格式，此时以对话框的选择为准。
 *
 * @returns 保存后的路径；用户取消对话框时 filePath 为 null
 */
export async function exportSheetImage(
    options: Parameters<typeof renderSheetImage>[0] & { format?: ImageFormat },
): Promise<{ filePath: string | null; rendered: IRenderedSheetImage }> {
    const preferred = options.format ?? 'png';
    const preferredMeta = FORMAT_META[preferred];

    // 选中的格式排在最前，作为对话框的默认类型；其余格式仍可选
    const filters = [
        preferredMeta.filter,
        ...(Object.keys(FORMAT_META) as ImageFormat[])
            .filter((f) => f !== preferred)
            .map((f) => FORMAT_META[f].filter),
    ];

    const { canceled, filePath } = await systemUtil.showSaveDialog({
        title: '保存歌单分享图',
        defaultPath: buildDefaultFileName(options.sheet?.title, preferredMeta.ext),
        filters,
        properties: ['showOverwriteConfirmation'],
    });

    if (canceled || !filePath) {
        return { filePath: null, rendered: await renderSheetImage(options) };
    }

    // 以用户最终选定的扩展名为准（Electron 不会自动改扩展名）
    const format = formatFromPath(filePath, preferred);
    const rendered = await renderSheetImage({ ...options, format });

    // 注意：渲染进程没有 Buffer（沙箱化），必须传 Uint8Array 而不是 base64 字符串，
    // 否则 preload 侧的 fsp.writeFile 会按 utf8 写，图片会损坏
    await fsUtil.writeFile(filePath, dataUrlToBytes(rendered.dataUrl));

    return { filePath, rendered };
}

/** 把长图 dataURL 复制到系统剪贴板（图片剪贴板） */
export async function copySheetImageToClipboard(dataUrl: string): Promise<void> {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/**
 * 生成「导入文本」：把片段按行拼成人能读、机器也能解析的文本。
 * 用户可以直接粘贴到聊天窗口发给别人。
 */
export function buildImportText(fragments: { fragment: string }[], title?: string): string {
    const header = `【MusicFree 歌单分享】${title ?? ''}`.trim();
    const lines = fragments.map((it, index) => {
        const label = fragments.length > 1 ? `第 ${index + 1}/${fragments.length} 段：` : '';
        return `${label}${it.fragment}`;
    });
    return [
        header,
        '',
        '复制以下全部内容，在 MusicFree 中打开「导入歌单」→「粘贴导入文本」即可导入：',
        '',
        ...lines,
    ].join('\n');
}

/** 复制文本到剪贴板 */
export async function copyTextToClipboard(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
}

/**
 * 统一解码入口。
 *
 * @param payload 文本（片段文本 / 深链 / 聊天记录原文）或图片 dataURL
 */
export async function decodeSharePayload(
    payload: string,
): Promise<DecodeFragmentResult | DecodeImageOutcome> {
    const trimmed = payload.trim();
    if (trimmed.startsWith('data:image/')) {
        return decodeSheetFromImageDataUrl(trimmed);
    }
    return decodeSheetFromText(trimmed);
}

/** 让用户选择一张图片文件，返回其 dataURL */
export async function pickImageFileAsDataUrl(): Promise<string | null> {
    const { canceled, filePaths } = await systemUtil.showOpenDialog({
        title: '选择歌单分享图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });

    if (canceled || !filePaths?.length) {
        return null;
    }

    return readPathAsDataUrl(filePaths[0]);
}

/** 读取本地图片为 dataURL */
async function readPathAsDataUrl(filePath: string): Promise<string> {
    // preload 侧 readFile 返回 Buffer，跨 contextBridge 传过来后按 Uint8Array 处理
    const buffer = await fsUtil.readFile(filePath);
    const bytes =
        typeof buffer === 'string'
            ? new TextEncoder().encode(buffer)
            : new Uint8Array(buffer as unknown as ArrayBuffer);
    return readFileAsDataUrl(new Blob([bytes as unknown as BlobPart]));
}

/** 规整歌单数据：过滤掉没有 id 的脏数据，补齐可选的展示字段 */
export function normalizeSheetForShare(sheet: SheetLike): SheetLike {
    return {
        title: sheet.title,
        artist: sheet.artist,
        platform: sheet.platform,
        description: sheet.description,
        artwork: sheet.artwork,
        coverImg: sheet.coverImg,
        musicList: (sheet.musicList ?? []).filter((item) => !!item?.id),
    };
}
