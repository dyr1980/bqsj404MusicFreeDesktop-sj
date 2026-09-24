import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode, ImageDown, Copy, FileText, Loader2 } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import {
    buildImportText,
    copySheetImageToClipboard,
    copyTextToClipboard,
    encodeSheet,
    exportSheetImage,
    normalizeSheetForShare,
    previewFragmentCount,
    type IRenderedSheetImage,
    type SheetLike,
} from '@renderer/mainWindow/core/sheetShare';
import { messageOf } from '@renderer/mainWindow/core/sheetShare/useSheetImport';
import './index.scss';

/**
 * 可选导出格式。
 *
 * 实测结论（QR 码是大片高频噪点，PNG 几乎压不动，有损格式才省得下来）：
 *   PNG         无损基准
 *   JPEG q0.92  反而比 PNG 大！高画质下 JPEG 压不动二维码噪点
 *   JPEG q0.6   明显更小，二维码仍全部可读
 *   WebP        同画质下比 JPEG 更小
 */
const FORMAT_OPTIONS: Array<{ value: 'png' | 'jpeg' | 'webp'; label: string }> = [
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
    { value: 'png', label: 'PNG' },
];

/**
 * 质量档位（仅对 jpeg/webp 生效）。
 *
 * 实测：真实片段在 318px（2.5 px/模块）下，JPEG/WebP 即使压到 q0.2 仍能 100% 解码
 * ——二维码自带纠错冗余，很能吃压缩。真正会丢码的是「像素密度不足」
 * （整图被缩到 50% 以下），不是质量参数。所以这里可以放心取低值。
 */
const QUALITY_OPTIONS: Array<{ value: number; labelKey: string }> = [
    { value: 0.75, labelKey: 'sheetShare.quality_high' },
    { value: 0.55, labelKey: 'sheetShare.quality_balanced' },
    { value: 0.4, labelKey: 'sheetShare.quality_small' },
];

/** 默认格式与质量：JPEG + 最小质量（体积优先） */
const DEFAULT_FORMAT: 'png' | 'jpeg' | 'webp' = 'jpeg';
const DEFAULT_QUALITY = 0.4;

export interface ShareSheetImageModalProps {
    close: () => void;
    /** 要分享的歌单 */
    sheet: SheetLike;
    /** 分类标签（如「本地歌单」/平台名） */
    platformLabel?: string;
}

/**
 * ShareSheetImageModal — 把歌单导出成一张带二维码的长图
 *
 * 长图给人看，页脚二维码给机器读：对方用「导入歌单 → 选择分享图」即可还原。
 * 歌单过长时二维码会被限制在单图上限内，此时页脚会如实说明不完整，
 * 并引导使用「复制导入文本」。
 */
export default function ShareSheetImageModal({
    close,
    sheet,
    platformLabel,
}: ShareSheetImageModalProps) {
    const { t } = useTranslation();
    const [rendered, setRendered] = useState<IRenderedSheetImage | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>(DEFAULT_FORMAT);
    const [quality, setQuality] = useState(DEFAULT_QUALITY);

    const normalizedSheet = useMemo(() => normalizeSheetForShare(sheet), [sheet]);
    const songCount = normalizedSheet.musicList?.length ?? 0;
    // 编码 + CRC32 对大歌单是毫秒级同步开销，不能放在渲染体里裸调
    const estimatedQr = useMemo(
        () => (songCount ? previewFragmentCount(normalizedSheet) : 0),
        [normalizedSheet, songCount],
    );

    const fail = useCallback(
        (e: unknown) => {
            const message = messageOf(e);
            setError(message);
            showToast(t('sheetShare.failed'), { type: 'warn', description: message });
        },
        [t],
    );

    const handleGenerate = useCallback(async () => {
        if (!songCount) {
            showToast(t('sheetShare.empty'), { type: 'warn' });
            return;
        }
        setPending(true);
        setError(null);
        try {
            const result = await exportSheetImage({
                sheet: normalizedSheet,
                platformLabel,
                // 把面板选定的格式传给保存对话框，让「文件类型」与面板保持一致
                format,
                quality,
            });
            setRendered(result.rendered);
            if (result.filePath) {
                showToast(t('sheetShare.saved'), { description: result.filePath });
            }
        } catch (e) {
            fail(e);
        } finally {
            setPending(false);
        }
    }, [songCount, normalizedSheet, platformLabel, format, quality, t, fail]);

    const handleCopyImage = useCallback(async () => {
        if (!rendered) {
            return;
        }
        try {
            await copySheetImageToClipboard(rendered.dataUrl);
            showToast(t('sheetShare.copied'));
        } catch (e) {
            fail(e);
        }
    }, [rendered, t, fail]);

    const handleCopyText = useCallback(async () => {
        try {
            const encoded = encodeSheet(normalizedSheet);
            await copyTextToClipboard(buildImportText(encoded.fragments, normalizedSheet.title));
            showToast(t('sheetShare.copied'));
        } catch (e) {
            fail(e);
        }
    }, [normalizedSheet, t, fail]);

    return (
        <Modal
            open
            onClose={close}
            title={t('sheetShare.title')}
            subtitle={t('sheetShare.desc')}
            size="md"
            footer={
                <>
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<FileText size={16} />}
                        disabled={!songCount}
                        onClick={handleCopyText}
                    >
                        {t('sheetShare.copy_text')}
                    </Button>
                    {rendered && (
                        <Button
                            variant="secondary"
                            size="md"
                            icon={<Copy size={16} />}
                            onClick={handleCopyImage}
                        >
                            {t('sheetShare.copy_image')}
                        </Button>
                    )}
                    <Button
                        variant="primary"
                        size="md"
                        icon={pending ? <Loader2 size={16} /> : <ImageDown size={16} />}
                        disabled={pending || !songCount}
                        onClick={handleGenerate}
                    >
                        {pending
                            ? t('sheetShare.generating')
                            : rendered
                              ? t('sheetShare.regenerate')
                              : t('sheetShare.generate')}
                    </Button>
                </>
            }
        >
            <div className="sheet-share-image">
                <div className="sheet-share-image__meta">
                    <QrCode size={16} />
                    <span>{t('sheetShare.song_count', { count: songCount })}</span>
                    <span className="sheet-share-image__dot">·</span>
                    <span>
                        {estimatedQr <= 1
                            ? t('sheetShare.single_qr')
                            : t('sheetShare.qr_count', { count: estimatedQr })}
                    </span>
                </div>

                {/* 格式与质量：二维码是高频噪点，PNG 几乎压不动；有损格式可省一半以上体积 */}
                <div className="sheet-share-image__formats">
                    {FORMAT_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            className="sheet-share-image__format"
                            data-active={format === option.value}
                            onClick={() => setFormat(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                {format !== 'png' && (
                    <div className="sheet-share-image__qualities">
                        <span className="sheet-share-image__qualities-label">
                            {t('sheetShare.quality')}
                        </span>
                        {QUALITY_OPTIONS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                className="sheet-share-image__quality"
                                data-active={quality === option.value}
                                onClick={() => setQuality(option.value)}
                            >
                                {t(option.labelKey)}
                            </button>
                        ))}
                    </div>
                )}

                {rendered ? (
                    <div className="sheet-share-image__preview">
                        <img src={rendered.dataUrl} alt={sheet.title ?? ''} />
                        <div className="sheet-share-image__preview-meta">
                            {rendered.width} × {rendered.height}px ·{' '}
                            {(rendered.byteSize / 1024 / 1024).toFixed(2)}MB ·{' '}
                            {rendered.format.toUpperCase()}
                            {rendered.truncated ? ` · ${t('sheetShare.truncated_hint')}` : ''}
                        </div>
                    </div>
                ) : (
                    <div className="sheet-share-image__placeholder">
                        {pending ? t('sheetShare.generating') : t('sheetShare.desc')}
                    </div>
                )}

                {error && <div className="sheet-share-image__error">{error}</div>}
            </div>
        </Modal>
    );
}
