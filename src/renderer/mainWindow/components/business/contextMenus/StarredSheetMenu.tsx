import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showModal } from '../../ui/Modal/modalManager';
import { showToast } from '../../ui/Toast';
import musicSheet from '@infra/musicSheet/renderer';
import i18n from '@infra/i18n/renderer';
import { resolveRemoteShareSheet } from '@renderer/mainWindow/core/sheetShare';
import { QrCode, Trash2 } from 'lucide-react';

export interface StarredSheetMenuContext {
    /** 收藏时存下的完整歌单信息（标题/封面也在里面，分享长图要用） */
    sheetItem: IMusic.IMusicSheetItem;
}

/**
 * 打开整张远程歌单的分享弹窗。
 * 收藏的歌单未必被打开过，歌曲列表要回插件按页拉，因此先给一条「正在读取」提示。
 */
async function openShare(sheetItem: IMusic.IMusicSheetItem): Promise<void> {
    showToast(i18n.t('sheetShare.reading_sheet'));
    try {
        const sheet = await resolveRemoteShareSheet(sheetItem);
        if (!sheet.musicList?.length) {
            showToast(i18n.t('sheetShare.empty'), { type: 'warn' });
            return;
        }

        showModal('ShareSheetImageModal', {
            sheet,
            platformLabel: sheetItem.platform,
        });
    } catch (e) {
        showToast(i18n.t('sheetShare.read_failed'), {
            type: 'warn',
            description: e instanceof Error ? e.message : `${e}`,
        });
    }
}

/**
 * StarredSheetMenu — 收藏歌单右键菜单模板
 *
 * 在 Sidebar 的收藏歌单列表上右键触发，提供分享与取消收藏操作。
 */
export function StarredSheetMenu(ctx: StarredSheetMenuContext): ContextMenuEntry[] {
    const { sheetItem } = ctx;

    return [
        {
            id: 'share',
            icon: <QrCode />,
            label: i18n.t('sheetShare.title'),
            onClick() {
                void openShare(sheetItem);
            },
        },
        {
            id: 'unstar',
            icon: <Trash2 />,
            label: i18n.t('playlist.unstar'),
            danger: true,
            onClick() {
                musicSheet.unstarMusicSheet(sheetItem);
            },
        },
    ];
}
