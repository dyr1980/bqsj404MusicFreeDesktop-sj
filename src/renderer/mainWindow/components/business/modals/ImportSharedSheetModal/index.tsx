import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, ClipboardPaste, FileText, Loader2, Blocks } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { decodeSharePayload } from '@renderer/mainWindow/core/sheetShare';
import {
    consumeDecodeResult,
    decodeFromClipboardImage,
    decodeFromPickedImage,
    messageOf,
} from '@renderer/mainWindow/core/sheetShare/useSheetImport';
import './index.scss';

export interface ImportSharedSheetModalProps {
    close: () => void;
    /**
     * 深链带入的片段。有值时打开即自动解码，无需用户再选图。
     */
    fragment?: string;
}

/**
 * ImportSharedSheetModal — 导入别人分享的歌单
 *
 * 三个入口：选择分享图 / 从剪贴板图片 / 粘贴分享文本。
 * 前两者读取长图里的二维码，第三者走纯文本（分片太多、二维码被截断时用）。
 */
export default function ImportSharedSheetModal({ close, fragment }: ImportSharedSheetModalProps) {
    const { t } = useTranslation();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleResult = useCallback(
        (result: Awaited<ReturnType<typeof decodeSharePayload>> | 'empty' | null) => {
            if (result === null) {
                return;
            }
            if (result === 'empty') {
                showToast(t('sheetShare.import_clipboard_empty'), { type: 'warn' });
                return;
            }
            const consumed = consumeDecodeResult(result, t);
            if (consumed.status === 'consumed') {
                close();
                return;
            }
            setError(consumed.error);
            showToast(consumed.title, { type: 'warn', description: consumed.error });
        },
        [close, t],
    );

    const run = useCallback(
        async (
            job: () => Promise<Awaited<ReturnType<typeof decodeSharePayload>> | 'empty' | null>,
        ) => {
            setPending(true);
            setError(null);
            try {
                handleResult(await job());
            } catch (e) {
                const message = messageOf(e);
                setError(message);
                showToast(t('sheetShare.import_failed'), { type: 'warn', description: message });
            } finally {
                setPending(false);
            }
        },
        [handleResult, t],
    );

    // 深链带入片段时打开即解码（组件只挂载一次，故只跑一次）
    useEffect(() => {
        if (!fragment) {
            return;
        }
        void run(() => decodeSharePayload(fragment));
    }, [fragment, run]);

    const actions = useMemo(
        () => [
            {
                key: 'image',
                icon: <ImageIcon size={16} />,
                label: t('sheetShare.import_from_image'),
                variant: 'primary' as const,
                onClick: () => run(decodeFromPickedImage),
            },
            {
                key: 'clipboard',
                icon: <ClipboardPaste size={16} />,
                label: t('sheetShare.import_from_clipboard_image'),
                variant: 'secondary' as const,
                onClick: () => run(decodeFromClipboardImage),
            },
            {
                key: 'text',
                icon: <FileText size={16} />,
                label: t('sheetShare.import_from_text'),
                variant: 'secondary' as const,
                onClick: () => {
                    close();
                    showModal('ImportSharedTextModal', {});
                },
            },
            {
                // 从其他软件导入：直接输入链接，由所有支持 importMusicSheet 的插件并发探测
                key: 'plugin',
                icon: <Blocks size={16} />,
                label: t('sheetShare.import_from_plugin'),
                variant: 'secondary' as const,
                onClick: () => {
                    close();
                    showModal('ImportFromAppModal', {});
                },
            },
        ],
        [close, run, t],
    );

    return (
        <Modal
            open
            onClose={close}
            title={t('sheetShare.import_title')}
            subtitle={t('sheetShare.import_desc')}
            size="md"
        >
            <div className="sheet-share-import">
                <div className="sheet-share-import__actions">
                    {actions.map((action) => (
                        <Button
                            key={action.key}
                            variant={action.variant}
                            size="md"
                            icon={pending ? <Loader2 size={16} className="spin" /> : action.icon}
                            disabled={pending}
                            onClick={action.onClick}
                        >
                            {action.label}
                        </Button>
                    ))}
                </div>

                {pending && (
                    <div className="sheet-share-import__pending">
                        {t('sheetShare.import_decoding')}
                    </div>
                )}

                {error && <div className="sheet-share-import__error">{error}</div>}
            </div>
        </Modal>
    );
}
