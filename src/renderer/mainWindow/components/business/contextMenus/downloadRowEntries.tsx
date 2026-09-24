import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showModal } from '../../ui/Modal/modalManager';
import { showToast } from '../../ui/Toast';
import downloadManager from '@infra/downloadManager/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import i18n from '@infra/i18n/renderer';
import { CloudOff, ListX, Pause, Play, Trash2 } from 'lucide-react';
import type { IDownloadTask } from '@appTypes/infra/downloadManager';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

/**
 * 下载管理行在右键菜单里需要的字段。
 *
 * 故意写成结构化的小类型（而不是 import 页面里的 IDownloadRow），
 * 免得 business 层反向依赖 pages 层；IDownloadRow 天然满足它。
 */
export interface IDownloadMenuRow {
    kind: 'task' | 'downloaded' | 'upload';
    /** 记录归属的歌曲身份（云端清单记录按 platform + musicId + remotePath 定位） */
    platform: string;
    musicId: string;
    path?: string;
    /** 云端路径（「已传云端」的行才有） */
    remotePath?: string;
    task?: IDownloadTask;
    item?: IMusic.IMusicItem | IMusicItemSlim;
}

/**
 * buildDownloadRowEntries — 下载管理专用的右键菜单项
 *
 * 下载管理不再有多选操作条、也没有勾选框：批量（暂停 / 继续重试 / 移除任务 /
 * 删除记录 / 连本地文件一起删 / 移除上传记录 / 从云端删除）全部走右键菜单，
 * 和歌单等列表保持一致。
 *
 * 三种记录各有自己的「移除」语义，别混：
 *   - 下载任务   → 移除任务（下载进程 + task 行都没了）
 *   - 已下载记录 → 删除记录（本地文件保留） / 连本地文件一起删
 *   - 已传云端   → 移除上传记录（云端文件保留，只清记账） / 从云端删除（连云端文件）
 */
export function buildDownloadRowEntries(
    rows: readonly IDownloadMenuRow[] = [],
): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [];
    if (!rows.length) return entries;

    const tasks = rows.map((row) => row.task).filter((task): task is IDownloadTask => !!task);
    const pausable = tasks.filter(
        (task) => task.status === 'downloading' || task.status === 'pending',
    );
    const resumable = tasks.filter((task) => task.status === 'paused' || task.status === 'error');
    const recorded = rows.filter((row) => row.kind === 'downloaded');

    if (pausable.length) {
        entries.push({
            id: 'download-pause',
            icon: <Pause />,
            label: i18n.t('download.bulk_pause'),
            onClick: () => {
                for (const task of pausable) void downloadManager.pauseTask(task.id);
            },
        });
    }

    if (resumable.length) {
        entries.push({
            id: 'download-resume',
            icon: <Play />,
            label: i18n.t('download.bulk_resume'),
            onClick: () => {
                for (const task of resumable) {
                    if (task.status === 'paused') void downloadManager.resumeTask(task.id);
                    else void downloadManager.retryTask(task.id);
                }
            },
        });
    }

    if (tasks.length) {
        entries.push({
            id: 'download-remove-task',
            icon: <ListX />,
            label: i18n.t('download.remove_task'),
            danger: true,
            onClick: () => {
                for (const task of tasks) void downloadManager.removeTask(task.id);
                showToast(i18n.t('download.task_removed'));
            },
        });
    }

    if (recorded.length) {
        entries.push({
            id: 'download-remove-record',
            icon: <ListX />,
            label: i18n.t('download.bulk_remove'),
            onClick: () => {
                for (const row of recorded) {
                    void downloadManager.removeDownload(row.platform, row.musicId, false);
                }
                showToast(i18n.t('download.bulk_removed', { count: recorded.length }));
            },
        });

        entries.push({
            id: 'download-delete-file',
            icon: <Trash2 />,
            label: i18n.t('download.bulk_remove_file'),
            danger: true,
            onClick: () => {
                showModal('ConfirmModal', {
                    title: i18n.t('local_music.confirm_delete_title'),
                    message: i18n.t('download.confirm_delete_downloaded_message'),
                    confirmDanger: true,
                    onConfirm: () => {
                        for (const row of recorded) {
                            void downloadManager.removeDownload(row.platform, row.musicId, true);
                        }
                    },
                });
            },
        });
    }

    // ── 已传云端：移除上传记录（云端文件保留） / 从云端删除（移入云盘回收站） ──
    {
        const cloudRows = rows.filter(
            (row): row is IDownloadMenuRow & { remotePath: string } => !!row.remotePath,
        );
        if (cloudRows.length) {
            entries.push({
                id: 'download-remove-upload-record',
                icon: <ListX />,
                label: i18n.t('download.remove_upload_record'),
                onClick: () => {
                    void cloudDisk
                        .deleteUploadRecords(
                            cloudRows.map((row) => ({
                                platform: row.platform,
                                musicId: row.musicId,
                                remotePath: row.remotePath,
                            })),
                        )
                        .then((count) => {
                            showToast(i18n.t('download.upload_record_removed', { count }));
                        });
                },
            });

            entries.push({
                id: 'download-delete-from-cloud',
                icon: <CloudOff />,
                label: i18n.t('cloud_music.delete_from_cloud'),
                danger: true,
                onClick: () => {
                    showModal('ConfirmModal', {
                        title: i18n.t('local_music.confirm_delete_title'),
                        message: i18n.t('cloud_music.confirm_delete_message', {
                            count: cloudRows.length,
                        }),
                        confirmDanger: true,
                        onConfirm: async () => {
                            const paths = cloudRows.map((row) => row.remotePath);
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

    return entries;
}
