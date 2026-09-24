import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showModal } from '../../ui/Modal/modalManager';
import { showToast } from '../../ui/Toast';
import musicSheet from '@infra/musicSheet/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import i18n from '@infra/i18n/renderer';
import { DEFAULT_FAVORITE_SHEET_ID } from '@infra/musicSheet/common/constant';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import { toggleInSheetById } from '@renderer/mainWindow/core/sourceToggle';
import localSource from '@renderer/mainWindow/core/localSource';
import { resolveLocalShareSheet } from '@renderer/mainWindow/core/sheetShare';
import { uploadSheetToCloud } from '@renderer/mainWindow/core/cloudUpload';
import { Pencil, QrCode, Trash2, RefreshCw, CloudUpload, Download } from 'lucide-react';

export interface LocalSheetMenuContext {
    sheetId: string;
    sheetTitle: string;
}

/**
 * 打开整张歌单的批量换源弹窗。
 * 歌单可能未打开，因此先按 ID 拉取歌曲列表，再交给批量换源弹窗处理。
 */
async function openBatchToggle(sheetId: string): Promise<void> {
    const list = await musicSheet.getSheetMusicList(sheetId);
    if (!list.length) {
        showToast(i18n.t('music_toggle.empty_sheet'), { type: 'warn' });
        return;
    }

    showModal('ToggleSourceMoreModal', {
        musicItems: list as unknown as IMusic.IMusicItem[],
        onConfirm: async (pairs) => {
            const result = await toggleInSheetById(sheetId, pairs);
            if (result.applied === 0) {
                showToast(i18n.t('music_toggle.nothing_applied'), { type: 'warn' });
            }
        },
    });
}

/**
 * 下载整张歌单。
 * 歌单可能未打开，因此先按 ID 拉取歌曲列表；本地已经有文件的跳过
 * （「已有」看文件系统，记录还在但文件被删的歌应该能重新下）。
 */
async function downloadSheet(sheetId: string, sheetTitle: string): Promise<void> {
    const list = await musicSheet.getSheetMusicList(sheetId);
    const items = (list ?? []) as unknown as IMusic.IMusicItem[];
    const pending = items.filter(
        (item) => item.platform !== LOCAL_PLUGIN_NAME && !localSource.has(item),
    );

    if (!pending.length) {
        showToast(i18n.t('download.sheet_download_empty', { title: sheetTitle }), {
            type: 'warn',
        });
        return;
    }

    await downloadManager.addTasksBatch({ musicItems: pending });
    showToast(i18n.t('download.sheet_download_start', { count: pending.length }), {
        type: 'info',
    });
}

/**
 * 打开整张歌单的分享弹窗。
 * 歌单可能未打开，因此先按 ID 拉取歌曲列表，再交给分享弹窗处理。
 */
async function openShare(sheetId: string, sheetTitle: string): Promise<void> {
    const sheet = await resolveLocalShareSheet(sheetId, sheetTitle);
    if (!sheet.musicList?.length) {
        showToast(i18n.t('sheetShare.empty'), { type: 'warn' });
        return;
    }

    showModal('ShareSheetImageModal', {
        sheet,
        platformLabel: i18n.t('sheetShare.platform_local'),
    });
}

/**
 * LocalSheetMenu — 本地歌单右键菜单模板
 *
 * 在 Sidebar 的歌单列表上右键触发：
 *   - 任意歌单（含「我喜欢」）：分享歌单、批量更换来源插件
 *   - 非收藏歌单：重命名、删除
 */
export function LocalSheetMenu(ctx: LocalSheetMenuContext): ContextMenuEntry[] {
    const { sheetId, sheetTitle } = ctx;
    const isFavorite = sheetId === DEFAULT_FAVORITE_SHEET_ID;

    const entries: ContextMenuEntry[] = [
        {
            id: 'share',
            icon: <QrCode />,
            label: i18n.t('sheetShare.title'),
            onClick() {
                void openShare(sheetId, sheetTitle);
            },
        },
        {
            id: 'toggle-source',
            icon: <RefreshCw />,
            label: i18n.t('music_toggle.menu_sheet'),
            onClick() {
                void openBatchToggle(sheetId);
            },
        },
        {
            id: 'download-sheet',
            icon: <Download />,
            label: i18n.t('playlist.download_sheet'),
            onClick() {
                void downloadSheet(sheetId, sheetTitle);
            },
        },
        {
            id: 'upload-to-cloud',
            icon: <CloudUpload />,
            label: i18n.t('cloud_music.upload_sheet_to_cloud'),
            onClick() {
                void uploadSheetToCloud(sheetId, sheetTitle);
            },
        },
    ];

    if (isFavorite) return entries;

    entries.push(
        {
            id: 'rename',
            icon: <Pencil />,
            label: i18n.t('playlist.rename_sheet'),
            onClick() {
                showModal('RenameSheetModal', {
                    sheetId,
                    currentTitle: sheetTitle,
                });
            },
        },
        {
            id: 'delete',
            icon: <Trash2 />,
            label: i18n.t('playlist.delete_sheet'),
            danger: true,
            onClick() {
                showModal('ConfirmModal', {
                    title: i18n.t('playlist.delete_sheet'),
                    message: `${i18n.t('playlist.delete_sheet')}: ${sheetTitle}?`,
                    confirmDanger: true,
                    onConfirm: () => musicSheet.removeSheet(sheetId),
                });
            },
        },
    );

    return entries;
}
