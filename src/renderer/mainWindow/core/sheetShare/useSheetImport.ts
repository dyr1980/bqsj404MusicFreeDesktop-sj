/**
 * 导入流程的动作层
 *
 * 把「取数据 → 解码 → 提示 → 打开添加到歌单」这条链路收在一起，
 * 供导入弹窗与深链共用。
 */
import { decodeSheetFromImageDataUrl, pickImageFileAsDataUrl, readFileAsDataUrl } from './index';
import { describeDecodeError, presentDecodedSheet, type DecodeOutcome } from './uiAdapter';

type I18nFn = (key: string, options?: Record<string, unknown>) => string;

/** 消费解码结果的结果类型（用字符串判别式，避免 boolean 被泛化后无法收窄） */
export type ConsumeResult =
    | { status: 'consumed' }
    | { status: 'failed'; error: string; title: string };

/**
 * 统一收口：展示解码结果并进入导入流程。
 *
 * @returns 成功返回 { status: 'consumed' }；失败返回错误文案，由调用方决定怎么提示
 */
export function consumeDecodeResult(result: DecodeOutcome, t: I18nFn): ConsumeResult {
    if (result.status !== 'ok') {
        return {
            status: 'failed',
            title: t('sheetShare.import_failed'),
            error: describeDecodeError(result, t),
        };
    }

    const count = result.payload?.musicList?.length ?? 0;
    if (!count) {
        return {
            status: 'failed',
            title: t('sheetShare.import_failed'),
            error: t('sheetShare.import_bad_payload'),
        };
    }

    presentDecodedSheet(result.payload);
    return { status: 'consumed' };
}

/** 选择本地图片并解码 */
export async function decodeFromPickedImage(): Promise<DecodeOutcome | null> {
    const dataUrl = await pickImageFileAsDataUrl();
    if (!dataUrl) {
        return null;
    }
    return decodeSheetFromImageDataUrl(dataUrl);
}

/** 从剪贴板图片解码；剪贴板没有图片时返回 'empty' */
export async function decodeFromClipboardImage(): Promise<DecodeOutcome | 'empty'> {
    const items = await navigator.clipboard.read();
    const imageItem = items.find((item) => item.types.some((type) => type.startsWith('image/')));
    if (!imageItem) {
        return 'empty';
    }
    const type = imageItem.types.find((it) => it.startsWith('image/'))!;
    const blob = await imageItem.getType(type);
    const dataUrl = await readFileAsDataUrl(blob);
    return decodeSheetFromImageDataUrl(dataUrl);
}

/** 把任意异常转成可展示的文案 */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : `${error}`;
}
