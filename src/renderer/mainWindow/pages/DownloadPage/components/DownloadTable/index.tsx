import { memo, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Cloud, FolderOpen, ListX } from 'lucide-react';
import { cn } from '@common/cn';
import formatDateTime from '@common/formatDateTime';
import formatFileSize from '@common/formatFileSize';
import downloadManager from '@infra/downloadManager/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import { showToast } from '../../../../components/ui/Toast';
import { FavoriteButton } from '../../../../components/business/FavoriteButton';
import { DownloadButton } from '../../../../components/business/DownloadButton';
import { CloudButton } from '../../../../components/business/CloudButton';
import { DownloadProgressCell } from '../DownloadProgressCell';
import { TaskActions } from '../TaskActions';
import type { IDownloadRow, TDownloadSortOrder } from '../../downloadRows';
import './index.scss';

interface DownloadTableProps {
    rows: IDownloadRow[];
    selectedIds: Set<string>;
    onRowClick: (index: number, e: MouseEvent) => void;
    onRowDoubleClick?: (row: IDownloadRow, index: number) => void;
    onRowContextMenu?: (row: IDownloadRow, index: number, e: MouseEvent) => void;
    /** 时间列排序方向（默认 desc = 最新在前） */
    sortOrder: TDownloadSortOrder;
    /** 点「时间」列头切换排序方向 */
    onToggleSort: () => void;
    /** 状态列头里的筛选按钮（Excel 风格：点列头筛这一列） */
    statusFilter?: ReactNode;
}

/** 状态单元格 */
const StatusCell = memo(function StatusCell({ row }: { row: IDownloadRow }) {
    const { t } = useTranslation();

    if (row.kind === 'task' && row.task) {
        const task = row.task;
        const isActive = task.status === 'downloading' || task.status === 'paused';
        if (isActive) return <DownloadProgressCell task={task} />;
        if (task.status === 'pending') {
            return (
                <span className="p-download__status-text p-download__status-text--pending">
                    {t('download.waiting')}
                </span>
            );
        }
        if (task.status === 'error') {
            return (
                <button
                    type="button"
                    className="p-download__status-text p-download__status-text--error p-download__status-text--clickable"
                    title={t('common.download_failed_clear')}
                    onClick={(e) => {
                        e.stopPropagation();
                        void downloadManager.clearTaskError(task.id);
                    }}
                >
                    {t('download.failed')}
                </button>
            );
        }
    }

    // 状态列只描述**这条记录本身**（当时下成功 / 传成功），文件现在在不在由左边的图标回答，
    // 两者可以不一致（例如「已传云端」的记录 + 云端文件已被删）。
    if (row.status === 'uploaded') {
        return (
            <span className="p-download__status-text p-download__status-text--uploaded">
                {t('download.status_uploaded')}
            </span>
        );
    }

    return (
        <span className="p-download__status-text p-download__status-text--done">
            {t('download.status_done')}
        </span>
    );
});

/** 操作单元格 */
const ActionsCell = memo(function ActionsCell({ row }: { row: IDownloadRow }) {
    const { t } = useTranslation();

    const reveal = () => {
        if (row.path) systemUtil.showItemInFolder(row.path);
    };
    /**
     * 移除这条记录（不动磁盘上的文件）：
     *   - 已下载行 → 删下载记录（本地文件保留）
     *   - 已传云端行 → 删上传清单记录（云端文件保留）
     */
    const remove = () => {
        if (row.kind === 'task' && row.task) {
            void downloadManager.removeTask(row.task.id);
            return;
        }
        if (row.kind === 'downloaded') {
            void downloadManager.removeDownload(row.platform, row.musicId, false);
            return;
        }
        if (row.kind === 'upload' && row.remotePath) {
            void cloudDisk
                .deleteUploadRecords([
                    {
                        platform: row.platform,
                        musicId: row.musicId,
                        remotePath: row.remotePath,
                    },
                ])
                .then((count) => {
                    showToast(t('download.upload_record_removed', { count }));
                });
        }
    };

    return (
        <div className="p-download__actions">
            {row.kind === 'task' && row.task ? (
                <TaskActions task={row.task} />
            ) : (
                <>
                    {/* 文件已经不在的行不给「在文件夹中显示」（点了也是空的） */}
                    {row.path && !row.missing && (
                        <button
                            type="button"
                            className="p-download__action-btn"
                            onClick={reveal}
                            title={t('download.reveal_in_explorer')}
                        >
                            <FolderOpen size={16} />
                        </button>
                    )}
                    {(row.kind === 'downloaded' || row.kind === 'upload') && (
                        <button
                            type="button"
                            className="p-download__action-btn p-download__action-btn--danger"
                            onClick={remove}
                            title={
                                row.kind === 'upload'
                                    ? t('download.remove_upload_record')
                                    : t('download.remove_record')
                            }
                        >
                            <ListX size={16} />
                        </button>
                    )}
                </>
            )}
        </div>
    );
});

/**
 * DownloadTable — 下载管理的统一列表
 *
 * 行来自「下载任务 / 已下载 / 云端上传记录」三种来源（见 downloadRows.ts），
 * 默认按记录时间倒序（最新在最上面），点「时间」列头切换方向。
 * 多选语义走 core/selection（Ctrl 切换 / Shift 连选 / Ctrl+A 全选 / Esc 取消）。
 * 选中只有整行高亮：没有勾选框列，批量操作在右键菜单里。
 */
export function DownloadTable({
    rows,
    selectedIds,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
    sortOrder,
    onToggleSort,
    statusFilter,
}: DownloadTableProps) {
    const { t } = useTranslation();

    return (
        <table className="p-download__table">
            <thead>
                <tr className="p-download__header-row">
                    <th className="p-download__header-cell p-download__header-cell--state" />
                    <th className="p-download__header-cell">{t('download.col_title')}</th>
                    <th className="p-download__header-cell p-download__header-cell--artist">
                        {t('download.col_artist')}
                    </th>
                    <th className="p-download__header-cell p-download__header-cell--album">
                        {t('download.col_album')}
                    </th>
                    <th className="p-download__header-cell p-download__header-cell--size">
                        {t('download.col_size')}
                    </th>
                    {/* 时间列：默认最新在前，点一下切换方向 */}
                    <th
                        className="p-download__header-cell p-download__header-cell--time"
                        aria-sort={sortOrder === 'desc' ? 'descending' : 'ascending'}
                    >
                        <button
                            type="button"
                            className="p-download__sort-btn"
                            title={t('download.sort_toggle')}
                            onClick={onToggleSort}
                        >
                            <span className="p-download__header-label">
                                {t('download.col_time')}
                            </span>
                            {sortOrder === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                        </button>
                    </th>
                    <th className="p-download__header-cell p-download__header-cell--status">
                        <span className="p-download__header-label">{t('download.col_status')}</span>
                        {statusFilter}
                    </th>
                    <th className="p-download__header-cell p-download__header-cell--actions">
                        {t('download.col_actions')}
                    </th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row, index) => {
                    const selected = selectedIds.has(row.key);
                    return (
                        <tr
                            key={row.key}
                            className={cn('p-download__row', selected && 'is-selected')}
                            onClick={(e) => onRowClick(index, e)}
                            onDoubleClick={() => onRowDoubleClick?.(row, index)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                onRowContextMenu?.(row, index, e);
                            }}
                        >
                            {/* 状态图标：收藏 / 本地有没有文件 / 云端有没有（和歌曲列表的状态列同一套） */}
                            <td className="p-download__cell p-download__cell--state">
                                <div className="p-download__state-icons">
                                    <FavoriteButton musicItem={row.item} size="sm" />
                                    <DownloadButton musicItem={row.item} size="sm" />
                                    <CloudButton musicItem={row.item} size="sm" />
                                </div>
                            </td>
                            <td className="p-download__cell p-download__cell--title">
                                <div className="p-download__title-wrapper">
                                    {row.kind === 'upload' && (
                                        <Cloud
                                            size={13}
                                            className="p-download__kind-icon"
                                            aria-label={t('download.status_uploaded')}
                                        />
                                    )}
                                    <span className="p-download__song-title">{row.title}</span>
                                </div>
                            </td>
                            <td className="p-download__cell p-download__cell--artist">
                                {row.artist}
                            </td>
                            <td className="p-download__cell p-download__cell--album">
                                {row.album}
                            </td>
                            <td className="p-download__cell p-download__cell--size">
                                {row.size ? formatFileSize(row.size) : '-'}
                            </td>
                            <td className="p-download__cell p-download__cell--time">
                                {formatDateTime(row.time) || '-'}
                            </td>
                            <td className="p-download__cell p-download__cell--status">
                                <StatusCell row={row} />
                            </td>
                            <td className="p-download__cell p-download__cell--actions">
                                <ActionsCell row={row} />
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
