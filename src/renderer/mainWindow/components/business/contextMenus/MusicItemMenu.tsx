import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showToast } from '../../ui/Toast';
import { showModal } from '../../ui/Modal/modalManager';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { applyToggle } from '@renderer/mainWindow/core/sourceToggle';
import {
    RECENTLY_PLAYED_ID,
    removeFromRecentlyPlayed,
} from '@renderer/mainWindow/core/recentlyPlayed';
import { uploadItemsToCloud } from '@renderer/mainWindow/core/cloudUpload';
import cloudSource from '@renderer/mainWindow/core/cloudSource';
import localSource from '@renderer/mainWindow/core/localSource';
import cloudDisk from '@infra/cloudDisk/renderer';
import { buildDownloadRowEntries, type IDownloadMenuRow } from './downloadRowEntries';
import musicSheet from '@infra/musicSheet/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import localMusic from '@infra/localMusic/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import i18n from '@infra/i18n/renderer';
import { displayPlatform } from '@renderer/mainWindow/core/sourceLabel';
import { LOCAL_PLUGIN_NAME, CLOUD_PLUGIN_NAME } from '@common/constant';
import { compositeKey } from '@common/mediaKey';
import { PLAY_QUEUE_SHEET_ID, DOWNLOADED_SHEET_ID } from '@infra/musicSheet/common/constant';
import {
    Fingerprint,
    User,
    Disc3,
    ListEnd,
    ListPlus,
    ListX,
    Trash2,
    Download,
    CloudUpload,
    CloudOff,
    FolderOpen,
    RefreshCw,
} from 'lucide-react';

export interface MusicItemMenuContext {
    /** 单曲或多选的歌曲列表（下载管理里纯任务行没有歌曲条目，可以为空） */
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[];
    /**
     * 当前所在歌单 ID，控制"删除"菜单项的显隐：
     *   - undefined → 不在歌单内，不显示删除
     *   - PLAY_QUEUE_SHEET_ID → 播放队列，显示"从播放队列移除"
     *   - 其他 → 用户歌单，显示"从歌单内删除"
     */
    sheetId?: string;
    /**
     * 下载管理专用：本次右键命中的下载行（任务 / 已下载记录 / 上传记录）。
     * 传了它才会出现「暂停 / 继续重试 / 移除任务 / 删除记录 / 连本地文件一起删」，
     * 这些批量操作以前挂在多选操作条上，现在统一进右键菜单。
     */
    downloadRows?: IDownloadMenuRow[];
}

/** 复制文本到剪贴板并弹出 toast */
function copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text).then(
        () => showToast(i18n.t('common.copied')),
        () => showToast(i18n.t('common.copied')),
    );
}

/**
 * MusicItemMenu — 歌曲右键菜单模板
 *
 * 支持单曲和多选两种场景：
 *   - 单曲：顶部显示 ID / 作者 / 专辑（点击复制）+ 分割线 + 操作项
 *   - 多选：仅显示操作项（批量操作）
 *
 * 下载管理的行会额外带上 `downloadRows`，此时（且只有此时）追加下载任务 /
 * 下载记录的批量操作。
 *
 * 下载管理里三种记录（任务 / 已下载 / 已传云端）现在都带歌曲条目，所以上半部分
 * 的歌曲操作对三种行完全一致；带上 `downloadRows` 时有两处要避让：
 *   - 「下载」：已经在下载队列里的行不再出现（加了也是原地返回已有任务）
 *   - 「从云端删除」：交给 downloadRowEntries 按上传清单的 remotePath 删
 */
export function MusicItemMenu(ctx: MusicItemMenuContext): ContextMenuEntry[] {
    const { musicItems, sheetId } = ctx;
    const items = Array.isArray(musicItems) ? musicItems : [musicItems];
    const isSingle = items.length === 1;
    const downloadEntries = buildDownloadRowEntries(ctx.downloadRows);
    const hasDownloadRows = !!ctx.downloadRows?.length;
    /** 本次右键命中的行里已经在下载队列里的歌曲身份（避免菜单上再出现「下载」） */
    const queuedKeys = new Set(
        (ctx.downloadRows ?? []).map((row) => compositeKey(row.platform, String(row.musicId))),
    );

    const entries: ContextMenuEntry[] = [];

    // 下载管理里「等待中/下载中/已暂停」的行还没有歌曲条目，只能给下载操作
    if (!items.length) return downloadEntries;

    // ── 信息头（仅单曲） ──
    if (isSingle) {
        const singleItem = items[0];

        entries.push({
            id: 'info-id',
            icon: <Fingerprint />,
            label: `ID: ${displayPlatform(singleItem.platform, i18n.t)}@${singleItem.id}`,
            onClick: () => {
                // 复制出来的仍是真实平台标识（下面这行不受显示层改名影响）
                copyToClipboard(`${singleItem.platform}@${singleItem.id}`);
            },
        });

        entries.push({
            id: 'info-artist',
            icon: <User />,
            label: `${i18n.t('media.artist')}: ${singleItem.artist || i18n.t('media.unknown_artist')}`,
            onClick: () => {
                copyToClipboard(singleItem.artist || '');
            },
        });

        if (singleItem.album) {
            entries.push({
                id: 'info-album',
                icon: <Disc3 />,
                label: `${i18n.t('media.album')}: ${singleItem.album}`,
                onClick: () => {
                    copyToClipboard(singleItem.album ?? '');
                },
            });
        }

        entries.push({ type: 'separator' });
    }

    // ── 下一首播放 ──
    entries.push({
        id: 'play-next',
        icon: <ListEnd />,
        label: i18n.t('playback.next_play'),
        onClick: () => {
            trackPlayer.addNext(items);
            showToast(i18n.t('playback.added_to_next'));
        },
    });

    // ── 添加到歌单 ──
    entries.push({
        id: 'add-to-sheet',
        icon: <ListPlus />,
        label: i18n.t('playlist.add_to_sheet_menu'),
        onClick: () => {
            showModal('AddMusicToSheetModal', { musicItems: items });
        },
    });

    // ── 更换来源插件 ──
    // 仅在可持久化的列表中提供（歌单 / 播放队列 / 最近播放）；
    // 已下载歌单内的歌曲是本地文件，无在线来源可换。
    if (sheetId && sheetId !== DOWNLOADED_SHEET_ID) {
        entries.push({
            id: 'toggle-source',
            icon: <RefreshCw />,
            label: isSingle
                ? i18n.t('music_toggle.menu')
                : i18n.t('music_toggle.menu_batch', { count: items.length }),
            onClick: () => {
                if (isSingle) {
                    const target = items[0];
                    showModal('ToggleSourceModal', {
                        musicItem: target,
                        onConfirm: async (newItem) => {
                            await applyToggle(sheetId, [
                                {
                                    old: { platform: target.platform, id: String(target.id) },
                                    new: newItem,
                                },
                            ]);
                        },
                    });
                } else {
                    showModal('ToggleSourceMoreModal', {
                        musicItems: items,
                        onConfirm: async (pairs) => {
                            await applyToggle(sheetId, pairs);
                        },
                    });
                }
            },
        });
    }

    // ── 从歌单内删除（仅在用户歌单内，排除特殊歌单） ──
    if (
        sheetId &&
        sheetId !== PLAY_QUEUE_SHEET_ID &&
        sheetId !== RECENTLY_PLAYED_ID &&
        sheetId !== DOWNLOADED_SHEET_ID
    ) {
        entries.push({
            id: 'remove-from-sheet',
            icon: <Trash2 />,
            label: i18n.t('playlist.remove_from_sheet'),
            danger: true,
            onClick: () => {
                musicSheet.removeMusicFromSheet(items, sheetId);
            },
        });
    }

    // ── 从播放队列移除 ──
    if (sheetId === PLAY_QUEUE_SHEET_ID) {
        entries.push({
            id: 'remove-from-queue',
            icon: <Trash2 />,
            label: i18n.t('playback.remove_from_queue'),
            danger: true,
            onClick: () => {
                trackPlayer.removeMusic(items);
            },
        });
    }

    // ── 从最近播放移除 ──
    if (sheetId === RECENTLY_PLAYED_ID) {
        entries.push({
            id: 'remove-from-recently-played',
            icon: <Trash2 />,
            label: i18n.t('history.remove'),
            danger: true,
            onClick: () => {
                removeFromRecentlyPlayed(items);
            },
        });
    }

    // ── 已下载 / 本地歌曲操作（打开文件夹 + 删除下载记录）——仅单曲 ──
    // 下载管理传了 downloadRows 时，删除记录 / 删除文件由 buildDownloadRowEntries
    // 统一提供（还支持多选），这里不再重复一份。
    if (isSingle) {
        const singleItem = items[0];
        // 「有本地文件」看文件系统（core/localSource），「有下载记录」看记录：
        // 记录还在但文件被删了 → 不给「在文件夹中显示」，只留「删除记录」
        const downloaded = downloadManager.isDownloaded(singleItem);
        const localFilePath = localSource.getPath(singleItem);
        const isLocal = !!localFilePath || singleItem.platform === LOCAL_PLUGIN_NAME;

        if (isLocal) {
            entries.push({
                id: 'reveal-in-explorer',
                icon: <FolderOpen />,
                label: i18n.t('download.reveal_in_explorer'),
                onClick: async () => {
                    let revealPath: string | null = localFilePath;

                    try {
                        if (!revealPath && singleItem.platform === LOCAL_PLUGIN_NAME) {
                            // 获取raw
                            if (
                                typeof singleItem.url === 'string' &&
                                singleItem.url.startsWith('file:')
                            ) {
                                revealPath = fsUtil.fileUrlToPath(singleItem.url);
                            } else {
                                const rawItem = await musicSheet.getRawMusicItem(
                                    singleItem.platform,
                                    singleItem.id,
                                );
                                if (
                                    rawItem &&
                                    typeof rawItem.url === 'string' &&
                                    rawItem.url.startsWith('file:')
                                ) {
                                    revealPath = fsUtil.fileUrlToPath(rawItem.url);
                                }
                            }
                        }

                        if (revealPath) {
                            const ok = await systemUtil.showItemInFolder(revealPath);
                            if (!ok) {
                                showToast(i18n.t('local_music.reveal_fail'));
                            }
                        } else {
                            throw new Error('No local file path found');
                        }
                    } catch {
                        showToast(i18n.t('local_music.reveal_fail'));
                    }
                },
            });
        }

        if (downloaded && sheetId === DOWNLOADED_SHEET_ID && !hasDownloadRows) {
            // 删除下载记录（保留本地文件）—— 仅在下载歌单中显示
            entries.push({
                id: 'remove-download-record',
                icon: <ListX />,
                label: i18n.t('download.remove_record'),
                onClick: () => {
                    downloadManager.removeDownload(
                        singleItem.platform,
                        String(singleItem.id),
                        false,
                    );
                },
            });
        }

        if (downloaded && localFilePath && !hasDownloadRows && sheetId === DOWNLOADED_SHEET_ID) {
            // 删除已下载的本地文件（同时删除下载记录）—— 文件真的在才给。
            //
            // 限定在「已下载」歌单里：这一项与下面「删除本地文件」语义不同
            // （它连下载记录一起删，走 downloadManager），两个都满足时会出现两个同名菜单项。
            // 所以按上下文分工：已下载歌单 → 这一项；其它地方（含本地音乐页）→ 下面那一项。
            entries.push({
                id: 'delete-local-file',
                icon: <Trash2 />,
                label: i18n.t('local_music.delete_file'),
                danger: true,
                onClick: () => {
                    showModal('ConfirmModal', {
                        title: i18n.t('local_music.confirm_delete_title'),
                        message: i18n.t('local_music.confirm_delete_message'),
                        confirmDanger: true,
                        onConfirm: () => {
                            downloadManager.removeDownload(
                                singleItem.platform,
                                String(singleItem.id),
                                true,
                            );
                        },
                    });
                },
            });
        }
    }

    // ── 删除本地文件（支持批量，移至回收站 + 从所有歌单移除 + 从播放队列移除） ──
    //
    // 判断依据是「这首歌在本地真的有文件」（文件真值索引），而**不是** platform 是不是 '本地'：
    // 本地音乐库里的条目会挂到它对应的插件身份上（见 localMusic 的身份重挂），
    // 只按 platform === '本地' 判断会让「本地音乐」页里根本看不到这一项。
    {
        const allLocalFiles =
            items.length > 0 &&
            items.every((item) => item.platform === LOCAL_PLUGIN_NAME || localSource.has(item));

        // 「已下载」歌单里由上面那一项负责（语义是"连下载记录一起删"），这里排除掉避免重复
        if (allLocalFiles && sheetId !== DOWNLOADED_SHEET_ID) {
            entries.push({
                id: 'delete-local-music',
                icon: <Trash2 />,
                label: i18n.t('local_music.delete_file'),
                danger: true,
                onClick: () => {
                    const message =
                        items.length === 1
                            ? i18n.t('local_music.confirm_trash_message')
                            : i18n.t('local_music.confirm_trash_batch_message', {
                                  count: items.length,
                              });

                    showModal('ConfirmModal', {
                        title: i18n.t('local_music.confirm_delete_title'),
                        message,
                        confirmDanger: true,
                        onConfirm: async () => {
                            await localMusic.deleteItems(items);
                            musicSheet.removeFromAllSheets(items);
                            trackPlayer.removeMusic(items);
                        },
                    });
                },
            });
        }
    }

    // ── 从云端删除（云盘里的条目，支持多选） ──
    // 下载管理传了 downloadRows 时不走这里：那边的「从云端删除」按上传清单的
    // remotePath 删（同一首歌的清单记录可能不在当前歌曲身份下）。
    {
        const cloudItems = hasDownloadRows
            ? []
            : items.filter((item) => item.platform === CLOUD_PLUGIN_NAME);
        if (cloudItems.length) {
            entries.push({
                id: 'delete-from-cloud',
                icon: <CloudOff />,
                label: i18n.t('cloud_music.delete_from_cloud'),
                danger: true,
                onClick: () => {
                    showModal('ConfirmModal', {
                        title: i18n.t('local_music.confirm_delete_title'),
                        message: i18n.t('cloud_music.confirm_delete_message', {
                            count: cloudItems.length,
                        }),
                        confirmDanger: true,
                        onConfirm: async () => {
                            // 远端文件移入云盘回收站（不物理删除）
                            const paths = cloudItems.map((item) => String(item.id));
                            const count = await cloudDisk.moveToTrash(paths);
                            if (count < paths.length) {
                                showToast(
                                    i18n.t('cloud_music.delete_partial', {
                                        done: count,
                                        total: paths.length,
                                    }),
                                    { type: 'warn' },
                                );
                            } else {
                                showToast(i18n.t('cloud_music.delete_done', { count }));
                            }
                        },
                    });
                },
            });
        }
    }

    // ── 传至云端（云端已有的不再出现） ──
    // 本地有文件就传本地文件；本地没有的话主进程会取源边下边传，
    // 所以这里不再按「有没有本地文件」过滤。
    {
        const notOnCloud = items.filter((item) => !cloudSource.hasItem(item));
        if (notOnCloud.length > 0) {
            entries.push({
                id: 'upload-to-cloud',
                icon: <CloudUpload />,
                label: i18n.t('cloud_music.upload_to_cloud'),
                onClick: () => {
                    void uploadItemsToCloud(notOnCloud);
                },
            });
        }
    }

    // ── 下载（本地已有文件时隐藏，已在下载队列里的也隐藏） ──
    {
        const notDownloaded = items.filter(
            (item) =>
                !localSource.has(item) &&
                item.platform !== LOCAL_PLUGIN_NAME &&
                !queuedKeys.has(compositeKey(item.platform, String(item.id))),
        );

        if (notDownloaded.length > 0) {
            entries.push({
                id: 'download',
                icon: <Download />,
                label: i18n.t('common.download'),
                onClick: () => {
                    downloadManager.addTasksBatch({ musicItems: notDownloaded });
                },
            });
        }
    }

    // ── 下载管理的行级/批量操作（暂停 / 继续重试 / 移除任务 / 删除记录 / 删除文件） ──
    if (downloadEntries.length) {
        entries.push({ type: 'separator' });
        entries.push(...downloadEntries);
    }

    return entries;
}
