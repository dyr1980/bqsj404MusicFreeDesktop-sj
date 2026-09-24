import { useCallback, type ReactNode } from 'react';
import { DndContext, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import {
    SortableContext,
    horizontalListSortingStrategy,
    rectSortingStrategy,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@common/cn';
import { TagLongPressSensor } from './longPressSensor';
import './index.scss';

/** 长按判定时长（ms）——按住这么久才开始拖动，短按仍然是普通点击 */
export const LONG_PRESS_DELAY_MS = 300;

/**
 * 指针**移出标签范围之后**的容忍距离（px）。
 *
 * 在标签范围内移动不会取消长按（由 TagLongPressSensor 按标签矩形判定）；
 * 只有指针移出标签后，位移超过这个值才真正放弃本次长按。
 */
const ESCAPE_TOLERANCE = 16;

/** row = 单行不换行；grid = 可换行的标签云 */
export type SortableTagsLayout = 'row' | 'grid';

// ────────────────────────────────────────────────────────────────────────────
// SortableTags — 只提供拖拽上下文，不额外产生 DOM 层级
//
// 刻意不渲染包裹容器：SortableTag 必须是现有 flex 容器的直接子元素，
// 否则父容器的 gap / flex-wrap / overflow 都会作用到包裹层上，
// 导致 TabBar 的换行与横向滚动失效。
// ────────────────────────────────────────────────────────────────────────────

export interface SortableTagsProps {
    /** 当前顺序的 id 列表（与子元素一一对应） */
    ids: string[];
    /** 拖拽结束回调，参数为 ids 中的索引 */
    onSortEnd?: (fromIndex: number, toIndex: number) => void;
    /** 布局策略：单行用 row，可换行用 grid */
    layout?: SortableTagsLayout;
    children: ReactNode;
}

export function SortableTags({ ids, onSortEnd, layout = 'row', children }: SortableTagsProps) {
    // 长按判定 = 按满 delay 且指针仍在标签范围内：
    //   - 短按（未满 delay）不会激活拖拽，点击照常生效
    //   - 等待期间在标签范围内移动不会取消（TagLongPressSensor 覆写）
    //   - 右键不参与拖拽（PointerSensor 的激活器对非左键返回 false）
    const sensors = useSensors(
        useSensor(TagLongPressSensor, {
            activationConstraint: { delay: LONG_PRESS_DELAY_MS, tolerance: ESCAPE_TOLERANCE },
        }),
    );

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over || active.id === over.id) return;

            const fromIndex = ids.indexOf(String(active.id));
            const toIndex = ids.indexOf(String(over.id));
            if (fromIndex < 0 || toIndex < 0) return;

            onSortEnd?.(fromIndex, toIndex);
        },
        [ids, onSortEnd],
    );

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
                items={ids}
                strategy={layout === 'grid' ? rectSortingStrategy : horizontalListSortingStrategy}
            >
                {children}
            </SortableContext>
        </DndContext>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// SortableTag — 单个可拖拽标签的包裹层
// ────────────────────────────────────────────────────────────────────────────

export interface SortableTagProps {
    id: string;
    children: ReactNode;
    className?: string;
    disabled?: boolean;
    /** 悬浮提示（用于告知「长按可拖动排序」这类隐藏手势） */
    title?: string;
}

export function SortableTag({
    id,
    children,
    className,
    disabled = false,
    title,
}: SortableTagProps) {
    const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id,
        disabled,
    });

    return (
        <div
            ref={setNodeRef}
            // 只挂监听器，不挂 dnd-kit 的 attributes：
            // 包裹层内部已经是 button，再加 role="button"/tabIndex 会产生嵌套交互元素与重复 Tab 停靠点。
            {...listeners}
            className={cn('sortable-tag', isDragging && 'is-dragging', className)}
            title={title}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                touchAction: 'none',
            }}
        >
            {children}
        </div>
    );
}

export default SortableTags;
