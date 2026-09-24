import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { decodeSharePayload } from '@renderer/mainWindow/core/sheetShare';
import {
    consumeDecodeResult,
    messageOf,
} from '@renderer/mainWindow/core/sheetShare/useSheetImport';
import './index.scss';

export interface ImportSharedTextModalProps {
    close: () => void;
}

/**
 * ImportSharedTextModal — 粘贴分享文本导入
 *
 * 用 textarea 而不是单行输入：分片分享文本每段上千字符，
 * 单行输入既看不清也容易误删。
 */
export default function ImportSharedTextModal({ close }: ImportSharedTextModalProps) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleImport = useCallback(async () => {
        const trimmed = text.trim();
        if (!trimmed) {
            return;
        }
        setPending(true);
        setError(null);
        try {
            const result = await decodeSharePayload(trimmed);
            const consumed = consumeDecodeResult(result, t);
            if (consumed.status === 'consumed') {
                close();
                return;
            }
            setError(consumed.error);
            showToast(consumed.title, { type: 'warn', description: consumed.error });
        } catch (e) {
            const message = messageOf(e);
            setError(message);
            showToast(t('sheetShare.import_failed'), { type: 'warn', description: message });
        } finally {
            setPending(false);
        }
    }, [text, close, t]);

    return (
        <Modal
            open
            onClose={close}
            title={t('sheetShare.import_from_text')}
            subtitle={t('sheetShare.import_text_desc')}
            size="md"
            footer={
                <>
                    <Button variant="secondary" size="md" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        loading={pending}
                        disabled={!text.trim()}
                        icon={pending ? undefined : <Loader2 size={16} />}
                        onClick={handleImport}
                    >
                        {pending ? t('sheetShare.import_decoding') : t('common.confirm')}
                    </Button>
                </>
            }
        >
            <div className="sheet-share-text">
                <textarea
                    className="sheet-share-text__input"
                    autoFocus
                    spellCheck={false}
                    value={text}
                    placeholder={t('sheetShare.import_text_placeholder')}
                    onChange={(e) => {
                        setText(e.target.value);
                        setError(null);
                    }}
                />
                {error && <div className="sheet-share-text__error">{error}</div>}
            </div>
        </Modal>
    );
}
