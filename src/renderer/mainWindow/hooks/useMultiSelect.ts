import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DependencyList,
    type RefObject,
} from 'react';
import {
    applyClickSelection,
    isEditableTarget,
    isSelectAllKey,
    isSelectionTargetActive,
    markSelectionRoot,
    selectAllIds,
    type ISelectionMods,
} from '../core/selection';
import { registerSelectionProvider } from '../core/overlay';

export interface IUseMultiSelectOptions<T> {
    /** 当前列表（顺序 = 展示顺序，Shift 连选按它取范围） */
    items: readonly T[];
    /** 取行 id —— 请用 useCallback 固定引用，否则每次都重算 id 数组 */
    getId: (item: T) => string;
    /** 这些依赖变化时清空选择（搜索词、筛选条件等） */
    resetDeps?: DependencyList;
    /** 是否响应 Ctrl/Cmd + A（默认 true） */
    enableSelectAll?: boolean;
    /** 受控的选中集合；不传则由 hook 内部维护 */
    selectedIds?: Set<string>;
    /** 受控模式下选中项变化回调 */
    onSelectionChange?: (ids: Set<string>) => void;
    /** 列表根元素：键盘快捷键只作用于「刚点过的那个列表」 */
    rootRef?: RefObject<HTMLElement | null>;
}

/**
 * useMultiSelect — 列表多选的**唯一状态实现**（SongTable 与自绘列表共用）
 *
 * 交互语义全部来自 `core/selection`：
 *   普通单击单选 / Ctrl 切换 / Shift 连选 / Ctrl+Shift 追加 / Ctrl+A 全选 / Esc 取消。
 * 组件只要把行的 onClick 转成 `handleRowClick(index, e)`、
 * 把行的右键转成 `resolveContextSelection(index)` 即可，不需要自己写选中逻辑。
 *
 * 曾经的坑：本地音乐、云端、最近播放、播放队列、下载管理各写一套（有的勾选框、
 * 有的底部操作条、有的没有 Esc），现在统一由这里 + `core/selection` 决定。
 */
export function useMultiSelect<T>({
    items,
    getId,
    resetDeps = [],
    enableSelectAll = true,
    selectedIds: controlledSelectedIds,
    onSelectionChange,
    rootRef,
}: IUseMultiSelectOptions<T>) {
    const [internalIds, setInternalIds] = useState<Set<string>>(() => new Set());

    const isControlled = controlledSelectedIds !== undefined;
    const selectedIds = controlledSelectedIds ?? internalIds;

    // ── 全部 id（顺序敏感：Shift 连选按它取范围） ──
    const ids = useMemo(() => items.map((item) => getId(item)), [items, getId]);

    // 最新值放 ref：让 handleRowClick / 键盘处理保持稳定引用
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const selectedRef = useRef(selectedIds);
    selectedRef.current = selectedIds;
    const anchorRef = useRef(-1);

    const commit = useCallback(
        (next: Set<string>) => {
            selectedRef.current = next;
            if (isControlled) onSelectionChange?.(next);
            else setInternalIds(next);
        },
        [isControlled, onSelectionChange],
    );
    const commitRef = useRef(commit);
    commitRef.current = commit;

    // 数据源 / 筛选条件变了 → 选择作废
    // （resetDeps 是调用方给的依赖数组，长度固定；故意不把 resetDeps 本身列进去）
    useEffect(() => {
        // 受控模式下选择归调用方管，这里不越权
        if (isControlled) return;
        anchorRef.current = -1;
        selectedRef.current = new Set();
        setInternalIds(new Set());
    }, resetDeps);

    /** 行点击 → 计算新选区并落地（返回值方便调用方立刻用） */
    const handleRowClick = useCallback((index: number, mods: ISelectionMods): Set<string> => {
        markSelectionRoot(rootRef?.current);
        const result = applyClickSelection(
            selectedRef.current,
            idsRef.current,
            index,
            anchorRef.current,
            mods,
        );
        anchorRef.current = result.anchor;
        commitRef.current(result.ids);
        return result.ids;
    }, []);

    /**
     * 右键行 → 返回这次右键菜单应该作用在哪些项上。
     *
     * 点到的行已在选区里 → 整个选区（批量操作）；
     * 点到的行不在选区里 → 把它变成单选（和其它列表行为一致）。
     */
    const resolveContextSelection = useCallback((index: number): T[] => {
        markSelectionRoot(rootRef?.current);
        const item = itemsRef.current[index];
        if (item === undefined) return [];
        const id = getId(item);
        if (selectedRef.current.has(id)) {
            return itemsRef.current.filter((it) => selectedRef.current.has(getId(it)));
        }
        anchorRef.current = index;
        const next = new Set([id]);
        commitRef.current(next);
        return [item];
    }, []);

    /** 按 id 集合取出条目（顺序 = 列表顺序） */
    const resolveSelectedItems = useCallback(
        (set: ReadonlySet<string>): T[] => itemsRef.current.filter((it) => set.has(getId(it))),
        [],
    );

    const clearSelection = useCallback(() => {
        markSelectionRoot(rootRef?.current);
        anchorRef.current = -1;
        commitRef.current(new Set());
    }, []);

    const selectAll = useCallback(() => {
        markSelectionRoot(rootRef?.current);
        commitRef.current(selectAllIds(idsRef.current));
    }, []);

    // ── 键盘：Ctrl/Cmd+A 全选（Esc 清选中的裁决在 core/overlay，全应用统一） ──
    // Esc 不在这里处理：由 `core/overlay` 统一决定「有选中先清选中，没选中关最上层浮层」，
    // 否则抽屉 / 弹窗 / 列表各拦一发，会出现「一发 Esc 把抽屉和全屏都关了」。
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (isEditableTarget(e.target)) return;
            if (!isSelectionTargetActive(rootRef?.current)) return;

            if (enableSelectAll && isSelectAllKey(e)) {
                e.preventDefault();
                markSelectionRoot(rootRef?.current);
                commitRef.current(selectAllIds(idsRef.current));
            }
        };

        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [enableSelectAll]);

    // ── 登记为「可清选中的列表」：Esc 时由 core/overlay 调用 clear ──
    useEffect(
        () =>
            registerSelectionProvider({
                root: () => rootRef?.current ?? null,
                hasSelection: () => selectedRef.current.size > 0,
                clear: () => {
                    markSelectionRoot(rootRef?.current);
                    anchorRef.current = -1;
                    commitRef.current(new Set());
                },
            }),
        [rootRef],
    );

    const selectedItems = useMemo(
        () => items.filter((item) => selectedIds.has(getId(item))),
        [items, selectedIds, getId],
    );

    return {
        selectedIds,
        selectedItems,
        setSelectedIds: commit,
        handleRowClick,
        resolveContextSelection,
        resolveSelectedItems,
        clearSelection,
        selectAll,
    };
}
