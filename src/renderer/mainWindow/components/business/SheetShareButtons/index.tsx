import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode, FileDown } from 'lucide-react';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import type { SheetLike } from '@renderer/mainWindow/core/sheetShare';

export interface SheetShareButtonsProps {
    /** 要分享的歌单信息（标题/作者/封面等） */
    sheet: SheetLike;
    /**
     * 歌单内的歌曲。
     *
     * 必须显式传入，不要指望挂在 sheet 上：
     * 版块页的歌曲列表是独立 state（useSheetDetail / useCurrentMusicList），
     * 不在 sheetItem 里，靠 sheet.musicList 会永远拿到空数组。
     */
    musicList: SheetLike['musicList'];
    /** 分类标签（如平台名 /「本地歌单」） */
    platformLabel?: string;
}

/**
 * SheetShareButtons — 歌单页工具栏里的分享/导入入口
 *
 * - 「分享歌单」生成长图（含二维码），给别人扫或看图
 * - 「导入歌单」从别人分享的长图/文本还原歌单
 *
 * 长图与二维码只依赖 title / artist / id / platform，
 * 所以远程歌单（来自插件）同样可以分享。
 */
export function SheetShareButtons({ sheet, musicList, platformLabel }: SheetShareButtonsProps) {
    const { t } = useTranslation();

    const count = musicList?.length ?? 0;
    const disabled = count === 0;

    const handleShare = useCallback(() => {
        if (disabled) return;
        showModal('ShareSheetImageModal', {
            sheet: { ...sheet, musicList },
            platformLabel,
        });
    }, [disabled, sheet, musicList, platformLabel]);

    const handleImport = useCallback(() => {
        showModal('ImportSharedSheetModal', {});
    }, []);

    return (
        <>
            <Button
                variant="secondary"
                size="md"
                icon={<QrCode size={16} />}
                disabled={disabled}
                title={disabled ? t('sheetShare.empty') : t('sheetShare.title')}
                onClick={handleShare}
            >
                {t('sheetShare.title')}
            </Button>
            <Button
                className="always-enabled"
                variant="secondary"
                size="md"
                icon={<FileDown size={16} />}
                onClick={handleImport}
            >
                {t('sheetShare.import_title')}
            </Button>
        </>
    );
}

export default SheetShareButtons;
