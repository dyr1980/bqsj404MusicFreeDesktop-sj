import { useCallback, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, LoaderCircle, CircleAlert } from 'lucide-react';
import { cn } from '@common/cn';
import downloadManager, { useMusicDownloadTask } from '@infra/downloadManager/renderer';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { useMusicLocalFile } from '@renderer/mainWindow/core/localSource';
import { LocalFileIcon } from '../SourceStateIcons';
import './index.scss';

/** DownloadButton 尺寸预设 */
export type DownloadButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DownloadButtonProps extends Omit<
    HTMLAttributes<HTMLButtonElement>,
    'onClick' | 'children'
> {
    /** 歌曲数据（完整或精简均可） */
    musicItem: IMusic.IMusicItem | IMusicItemSlim;
    /** 图标尺寸 */
    size?: DownloadButtonSize;
}

/**
 * DownloadButton — 业务组件
 *
 * 下载按钮，根据歌曲「本地有没有文件」和下载任务状态切换图标。
 * - 未下载：下载箭头，点击触发下载
 * - 等待中 / 下载中：旋转图标
 * - 已暂停：下载箭头，点击继续下载
 * - 下载失败：红色感叹号，**点击清除失败状态**（任务变灰色「已暂停」，
 *   图标回到下载箭头，不会自动重跑）
 * - 本地有文件：磁盘+对勾图标（磁盘上有这个文件），禁用
 *
 * 「本地有没有文件」以**文件系统为准**（`core/localSource`）：下载记录还在、文件被外部
 * 删掉时图标必须灭掉；本地库里的歌即使没有下载记录，只要文件在就亮着。
 *
 * 设计稿还原（像素级）：
 *   容器: inline-flex, items-center, justify-center, rounded-pill
 *   默认: bg transparent, color text-secondary
 *   hover: bg fill-subtle-hover, color text-primary
 *   已下载: color status-success-text, opacity disabled, cursor default
 *   下载中: color text-brand, icon spin
 *   下载失败: color status-danger-text, hover 可点击清除
 *   active: opacity 0.6
 *   尺寸: sm(--icon-sm) md(--icon-md) lg(--icon-lg) xl(--icon-xl)
 */
export function DownloadButton({
    musicItem,
    size = 'lg',
    className,
    ...rest
}: DownloadButtonProps) {
    const { t } = useTranslation();
    const hasLocalFile = useMusicLocalFile(musicItem);
    const taskStatus = useMusicDownloadTask(musicItem);
    const isError = taskStatus === 'error';
    const isPaused = taskStatus === 'paused';
    // 只有「等待中 / 下载中」才算在下载 → 转圈图标；暂停显示普通下载图标（可点击继续）
    const isDownloading = taskStatus === 'pending' || taskStatus === 'downloading';
    const isCompleted = !isError && !isDownloading && !isPaused && hasLocalFile;
    const isInactive = isCompleted || isDownloading;
    const lockRef = useRef(false);

    const handleClick = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (isInactive || lockRef.current) return;
            lockRef.current = true;

            try {
                if (isError) {
                    // 点失败图标 = 清除失败状态（变灰色「已暂停」，不自动重跑）
                    await downloadManager.clearErrorByMusicItem(musicItem);
                } else if (isPaused) {
                    // 已暂停 → 继续下载（重新取源）
                    await downloadManager.retryByMusicItem(musicItem);
                } else {
                    await downloadManager.addTask({ musicItem });
                }
            } catch (e) {
                console.error('[DownloadButton] download failed:', e);
            } finally {
                lockRef.current = false;
            }
        },
        [isInactive, isError, isPaused, musicItem],
    );

    let ariaLabel: string;
    let icon: ReactNode;

    if (isCompleted) {
        ariaLabel = t('common.downloaded');
        // 文件夹 + 对勾：本地已经有这个文件。和右侧的云端按钮配成一对
        // （文件夹 = 本地已有；云朵 = 云端已有）
        icon = <LocalFileIcon />;
    } else if (isDownloading) {
        ariaLabel = t('common.downloading');
        icon = <LoaderCircle size="100%" />;
    } else if (isError) {
        ariaLabel = t('common.download_failed_clear');
        icon = <CircleAlert size="100%" />;
    } else if (isPaused) {
        ariaLabel = t('common.resume_download');
        icon = <Download size="100%" />;
    } else {
        ariaLabel = t('common.download');
        icon = <Download size="100%" />;
    }

    return (
        <button
            type="button"
            className={cn(
                'download-btn',
                `download-btn--${size}`,
                isCompleted && 'is-completed',
                isDownloading && 'is-downloading',
                isError && 'is-error',
                isPaused && 'is-paused',
                className,
            )}
            disabled={isInactive}
            aria-label={ariaLabel}
            title={ariaLabel}
            onClick={handleClick}
            onDoubleClick={(e) => e.stopPropagation()}
            {...rest}
        >
            {icon}
        </button>
    );
}

export default DownloadButton;
