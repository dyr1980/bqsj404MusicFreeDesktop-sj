/**
 * usePluginTagReorder — 插件标签长按拖拽排序后的持久化
 *
 * 各处标签栏展示的都是「插件全集的一个子集」（例如排行榜页只显示支持
 * getTopLists 的插件），而顺序存在全局的 meta.order 上。因此不能用
 * 子集的索引直接写回 order，否则会把其它插件的位置冲掉。
 *
 * 策略：把子集成员在「全局顺序」中占据的槽位收集起来，按新顺序回填，
 * 其余插件相对位置保持不变。这样在任何一处拖动，效果都是最小且可预期的。
 */

import { useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import pluginManager from '@infra/pluginManager/renderer';
import { sortByPluginOrder } from '@infra/pluginManager/common/sortByOrder';

export function usePluginTagReorder() {
    return useCallback((visibleHashes: string[], fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;

        const nextVisible = arrayMove(visibleHashes, fromIndex, toIndex);

        // 全局顺序（含已禁用插件，它们同样占用槽位）
        const allSorted = sortByPluginOrder(
            pluginManager.getPlugins(),
            pluginManager.getPluginMeta(),
        );
        const visibleSet = new Set(visibleHashes);

        let cursor = 0;
        const nextGlobal = allSorted.map((p) =>
            visibleSet.has(p.hash) ? nextVisible[cursor++] : p.hash,
        );

        // batchSetPluginMeta 会先同步更新本地 atom（UI 立即重排），再异步落盘
        void pluginManager.batchSetPluginMeta(
            nextGlobal.map((hash, index) => ({ hash, meta: { order: index } })),
        );
    }, []);
}
