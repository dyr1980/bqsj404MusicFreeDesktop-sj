/**
 * 解码结果 → 文案 / 后续动作 的适配层
 *
 * 二维码图片、剪贴板图片、粘贴文本、深链四条入口都会走到这里，
 * 保证「错误提示」和「导入后续流程」只有一份实现。
 *
 * 注意：这里对 Modal 的依赖只用于「打开添加到歌单」（运行时调用），
 * 不 import modalRegistry，避免与弹窗注册表形成静态循环依赖。
 */
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import type { DecodeFragmentResult, SheetLike } from './codec';
import type { DecodeImageOutcome } from './decodeSheetImage';

export type DecodeOutcome = DecodeFragmentResult | DecodeImageOutcome;

type I18nFn = (key: string, options?: Record<string, unknown>) => string;

/** 把解码失败的结果翻译成人话 */
export function describeDecodeError(result: DecodeOutcome, t: I18nFn): string {
    if (result.status === 'ok') {
        return '';
    }
    if (result.status === 'incomplete') {
        // missing 只在图片解码的结果里有，文本/深链场景按"缺号未知"处理
        const missingList = 'missing' in result ? result.missing : undefined;
        const missing = missingList?.length ? missingList.join('、') : '-';
        return t('sheetShare.import_incomplete', {
            received: result.received,
            total: result.total,
            missing,
        });
    }
    if (result.status === 'no_qrcode') {
        return t('sheetShare.import_no_qrcode', { attempts: result.attempts });
    }
    if (result.status === 'image_too_large') {
        return t('sheetShare.import_image_too_large', {
            pixels: Math.round(result.pixels / 1_000_000),
            max: Math.round(result.maxPixels / 1_000_000),
        });
    }
    switch (result.code) {
        case 'CHECKSUM_MISMATCH':
            return t('sheetShare.import_checksum');
        case 'UNSUPPORTED_VERSION':
            return t('sheetShare.import_unsupported');
        default:
            return t('sheetShare.import_bad_payload');
    }
}

/** 解码出的歌曲补上必填字段，交给「添加到歌单」弹窗 */
export function toImportableMusicItems(payload: SheetLike) {
    return (payload?.musicList ?? []).map((item) => ({
        ...item,
        title: item.title ?? '',
        artist: item.artist ?? '',
        id: item.id ?? '',
        platform: item.platform ?? '',
    }));
}

/**
 * 打开「添加到歌单」。
 *
 * @returns 是否成功打开（歌单为空时返回 false）
 */
export function presentDecodedSheet(payload: SheetLike): boolean {
    const musicList = toImportableMusicItems(payload);
    if (!musicList.length) {
        return false;
    }
    showModal('AddMusicToSheetModal', { musicItems: musicList });
    return true;
}
