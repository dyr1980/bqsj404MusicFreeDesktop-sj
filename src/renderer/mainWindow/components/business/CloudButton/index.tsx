import { useCallback, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@common/cn';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { uploadItemsToCloud } from '@renderer/mainWindow/core/cloudUpload';
import cloudSource, { useMusicOnCloud } from '@renderer/mainWindow/core/cloudSource';
import { useMusicLocalFile } from '@renderer/mainWindow/core/localSource';
import { CloudFileIcon } from '../SourceStateIcons';
import './index.scss';

/** CloudButton 尺寸预设（与 DownloadButton 对齐） */
export type CloudButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface CloudButtonProps extends Omit<
    HTMLAttributes<HTMLButtonElement>,
    'onClick' | 'children'
> {
    /** 歌曲数据（完整或精简均可） */
    musicItem: IMusic.IMusicItem | IMusicItemSlim;
    /** 图标尺寸 */
    size?: CloudButtonSize;
}

/**
 * CloudButton — 业务组件
 *
 * 云端按钮：把这首歌传到云盘。
 * - 未上传：云朵 + 上传箭头，点击上传（有本地文件就传文件；没有就由主进程取源边下边传）
 * - 上传中：旋转加载图标
 * - 云端已有：云朵 + 对勾（禁用，表示云盘上确实有这份文件）
 *
 * 状态按**云盘上的真实文件**判断（不是上传清单）：同一首歌换个插件播/下载也算「已有」，
 * 见 core/cloudSource。
 */
export function CloudButton({ musicItem, size = 'lg', className, ...rest }: CloudButtonProps) {
    const { t } = useTranslation();
    const onCloud = useMusicOnCloud(musicItem);
    const hasLocalFile = useMusicLocalFile(musicItem);
    const [busy, setBusy] = useState(false);
    const lockRef = useRef(false);

    const handleClick = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (onCloud || busy || lockRef.current) return;
            lockRef.current = true;
            setBusy(true);
            try {
                await uploadItemsToCloud([musicItem as IMusic.IMusicItem]);
                await cloudSource.refresh();
            } catch (err) {
                console.error('[CloudButton] upload failed:', err);
            } finally {
                lockRef.current = false;
                setBusy(false);
            }
        },
        [onCloud, busy, musicItem],
    );

    let ariaLabel: string;
    let icon: ReactNode;

    if (onCloud) {
        ariaLabel = t('common.in_cloud');
        icon = <CloudFileIcon uploaded />;
    } else if (busy) {
        ariaLabel = t('common.uploading');
        icon = <LoaderCircle size="100%" />;
    } else {
        // 本地没有文件也能传：那种情况会去插件取音源，tooltip 说清楚，别让人以为要先下载
        ariaLabel = hasLocalFile
            ? t('common.upload_to_cloud')
            : t('cloud_music.upload_from_source');
        icon = <CloudFileIcon />;
    }

    return (
        <button
            type="button"
            className={cn(
                'cloud-btn',
                `cloud-btn--${size}`,
                onCloud && 'is-uploaded',
                busy && 'is-uploading',
                className,
            )}
            disabled={onCloud || busy}
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

export default CloudButton;
