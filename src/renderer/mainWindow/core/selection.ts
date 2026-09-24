/**
 * selection — 列表多选的**唯一语义实现**
 *
 * 全应用所有「多选」都必须走这里，避免各页面各写一套（曾经本地音乐、云端、
 * 最近播放、播放队列、下载管理的选法都不一样）：
 *
 *   - 普通单击          → 单选（并把它记为锚点）
 *   - Ctrl / Cmd + 单击 → 切换单行（不连续多选）
 *   - Shift + 单击      → 从锚点到当前行连选（连续多选）
 *   - Ctrl + Shift+单击 → 在已有选区上追加一段
 *   - Ctrl / Cmd + A    → 全选
 *   - Esc               → 取消多选（清空选择）
 *   - 右键已选中的行    → 保留整个选区（批量操作菜单）
 *   - 右键未选中的行    → 把选区换成该行
 *
 * 选中行只做整行高亮（没有勾选框、没有底部操作条），
 * 多选的批量操作一律放在右键菜单里（见 business/contextMenus）。
 * 计算部分是纯函数；`selectedIds` 与锚点由调用方（hooks/useMultiSelect）持有。
 */

/** 一次点击携带的修饰键（MouseEvent / KeyboardEvent 都满足） */
export interface ISelectionMods {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
}

/** 计算结果：新的选中集合 + 新的锚点 */
export interface ISelectionUpdate {
    ids: Set<string>;
    /** 下次 Shift 连选的起点（-1 = 还没有锚点） */
    anchor: number;
}

/**
 * 计算一次行点击后的选中集合。
 *
 * @param prev   当前选中集合
 * @param ids    当前列表的全部 id（顺序 = 展示顺序，Shift 连选按它取范围）
 * @param index  被点击行的下标
 * @param anchor 锚点下标（上一次「切换单个/单选」的行）
 * @param mods   修饰键
 */
export function applyClickSelection(
    prev: ReadonlySet<string>,
    ids: readonly string[],
    index: number,
    anchor: number,
    mods: ISelectionMods,
): ISelectionUpdate {
    const id = ids[index];
    if (id === undefined) return { ids: new Set(prev), anchor };

    const additive = !!(mods.ctrlKey || mods.metaKey);

    if (mods.shiftKey && anchor >= 0 && anchor < ids.length) {
        const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
        const next = additive ? new Set(prev) : new Set<string>();
        for (let i = from; i <= to; i++) {
            const value = ids[i];
            if (value !== undefined) next.add(value);
        }
        // Shift 连选不改锚点：可以反复调整范围终点
        return { ids: next, anchor };
    }

    if (additive) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { ids: next, anchor: index };
    }

    return { ids: new Set([id]), anchor: index };
}

/** 全选 */
export function selectAllIds(ids: readonly string[]): Set<string> {
    return new Set(ids);
}

/** 键盘事件是否是「全选」（Ctrl/Cmd + A） */
export function isSelectAllKey(e: KeyboardEvent): boolean {
    return (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A');
}

/** 键盘事件是否是「取消多选」（Esc） */
export function isEscapeKey(e: KeyboardEvent): boolean {
    return e.key === 'Escape' || e.key === 'Esc';
}

/** 事件目标是不是输入类元素（在输入框里 Ctrl+A 应该是「全选文本」） */
export function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    return (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
    );
}

/**
 * 最后一个被点过的列表根元素。
 *
 * 键盘快捷键绑在 window 上（列表容器不一定拿得到焦点），所以需要知道
 * 「用户刚才在哪个列表里点的」——同屏可能有多个列表（抽屉 + 页面）。
 */
let lastInteractedRoot: HTMLElement | null = null;

/** 记录用户刚交互过的列表（点击行 / 右键行时调用） */
export function markSelectionRoot(root: HTMLElement | null | undefined): void {
    lastInteractedRoot = root ?? null;
}

/**
 * 这个元素是不是「用户最后点过的那个列表」。
 *
 * Esc 清选中只看它（不看焦点在哪）：在弹窗里点过某个列表之后，焦点可能已经
 * 跑到别处，但这一发 Esc 仍然该清那个列表的选中。
 */
export function isLastInteractedRoot(root: HTMLElement | null | undefined): boolean {
    return !!root && lastInteractedRoot === root;
}

/**
 * 这次键盘事件是否该由这个列表响应：
 *   - 有元素聚焦  → 必须聚焦在本列表内（多列表同屏时各管各的）
 *   - 焦点在 body → 只有最后点过的那个列表响应（鼠标操作完焦点通常落回 body）
 */
export function isSelectionTargetActive(root: HTMLElement | null | undefined): boolean {
    if (!root || !root.isConnected) return false;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active !== document.documentElement) {
        return root.contains(active);
    }
    return lastInteractedRoot === null || lastInteractedRoot === root;
}
