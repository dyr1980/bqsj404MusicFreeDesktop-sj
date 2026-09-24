import { useCallback, useMemo, type MouseEvent } from 'react';
import { ListMusic } from 'lucide-react';
import type { NavigateFunction } from 'react-router';
import { safeParse } from '@common/safeSerialize';
import { showContextMenu } from '../../ui/ContextMenu/contextMenuManager';
import { musicSheetRoute } from '../../../routes';
import type { IStarredSheetItem } from '@appTypes/infra/musicSheet';

interface StarredSheetNavItemProps {
    item: IStarredSheetItem;
    pathname: string;
    navigate: NavigateFunction;
}

export default function StarredSheetNavItem({
    item,
    pathname,
    navigate,
}: StarredSheetNavItemProps) {
    const sheetPath = musicSheetRoute(item.platform, item.id);
    const fullItem = useMemo(
        () =>
            safeParse<IMusic.IMusicSheetItem>(item.raw) ?? {
                platform: item.platform,
                id: item.id,
                title: item.title ?? '',
            },
        [item.raw, item.platform, item.id, item.title],
    );

    const handleClick = useCallback(() => {
        navigate(sheetPath, { state: { sheetItem: fullItem } });
    }, [navigate, sheetPath, fullItem]);

    const handleContextMenu = useCallback(
        (e: MouseEvent) => {
            e.preventDefault();
            // 传完整 item：菜单里的「分享歌单」需要标题/封面（unstar 只用 platform + id）
            showContextMenu(
                'StarredSheetMenu',
                { x: e.clientX, y: e.clientY },
                {
                    sheetItem: {
                        ...fullItem,
                        platform: item.platform,
                        id: item.id,
                        title: item.title ?? fullItem.title ?? '',
                    },
                },
            );
        },
        [fullItem, item.platform, item.id, item.title],
    );

    return (
        <button
            className={`l-sidebar__nav-item${pathname === sheetPath ? ' is-active' : ''}`}
            type="button"
            data-roving-item
            onClick={handleClick}
            onContextMenu={handleContextMenu}
        >
            <ListMusic size={16} className="l-sidebar__nav-icon l-sidebar__nav-icon--muted" />
            <span className="l-sidebar__nav-label">{item.title ?? fullItem.title}</span>
        </button>
    );
}
