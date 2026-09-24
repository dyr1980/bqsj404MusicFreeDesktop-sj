import { useState, useEffect, useMemo, type DependencyList } from 'react';

/**
 * useSelection — SongTable 的**受控**多选状态
 *
 * 多选的交互语义（Ctrl 切换 / Shift 连选 / Ctrl+A 全选 / Esc 取消）由
 * SongTable + `hooks/useMultiSelect` + `core/selection` 统一实现；
 * 页面只有在需要自己拿到选中集合（或需要在筛选变化时清空）时才用它。
 *
 * @param resetDeps - 任一依赖变化时清空选择。典型值：搜索词、筛选条件、当前歌单。
 * @returns `selectedIds`、`setSelectedIds`，以及可直接展开到 `<SongTable />` 的 `selectionProps`。
 */
export function useSelection(resetDeps: DependencyList) {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        setSelectedIds(new Set());
    }, resetDeps);

    const selectionProps = useMemo(
        () => ({
            selectedIds,
            onSelectionChange: setSelectedIds,
        }),
        [selectedIds],
    );

    return { selectedIds, setSelectedIds, selectionProps };
}
