/**
 * usePluginContextMenu — 插件标签右键菜单
 *
 * 排行榜 / 热门歌单的插件 Tab、搜索结果页的插件 Chip 共用：
 * 在右键位置弹出 PluginMenu，提供「更新」与「卸载」。
 */

import { useCallback, type MouseEvent } from 'react';
import { showContextMenu } from '../components/ui/ContextMenu/contextMenuManager';

/**
 * @param plugins 当前可用的插件列表（用于把 key/hash 还原为插件信息）
 * @returns 右键处理器 (hash, event) => void
 */
export function usePluginContextMenu(plugins: IPlugin.IPluginDelegate[]) {
    return useCallback(
        (hash: string, e: MouseEvent<HTMLButtonElement>) => {
            const plugin = plugins.find((p) => p.hash === hash);
            if (!plugin) return;

            e.preventDefault();
            showContextMenu(
                'PluginMenu',
                { x: e.clientX, y: e.clientY },
                {
                    hash: plugin.hash,
                    platform: plugin.platform,
                },
            );
        },
        [plugins],
    );
}
