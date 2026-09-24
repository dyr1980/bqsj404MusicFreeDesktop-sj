import { useCallback } from 'react';
import { FavoriteButton } from '../../../components/business/FavoriteButton';
import { DownloadButton } from '../../../components/business/DownloadButton';
import { CloudButton } from '../../../components/business/CloudButton';

/**
 * Status column renderer (❤ + ⬇ + ☁) shared by all local music song tables.
 *
 * 必须和其它列表一样用 `size="sm"`（16px）：状态列固定 96px，三个 28px 的
 * lg 图标会超出单元格（overflow: hidden）把最后那个云端按钮整个裁掉。
 */
export function useStatusColumn() {
    return useCallback(
        (item: IMusic.IMusicItemBase) => (
            <>
                <FavoriteButton musicItem={item as IMusic.IMusicItem} size="sm" />
                <DownloadButton musicItem={item as IMusic.IMusicItem} size="sm" />
                <CloudButton musicItem={item as IMusic.IMusicItem} size="sm" />
            </>
        ),
        [],
    );
}
