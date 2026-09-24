/**
 * TagLongPressSensor — 以「标签范围」判定长按的自定义传感器
 *
 * 背景：dnd-kit 内置的 `{ delay, tolerance }` 约束中，tolerance 是**固定像素值**，
 * 长按等待期间指针位移一旦超过它就会取消本次长按。默认给的 8px 太小：
 * 鼠标按下的瞬间常有轻微滑动（或轨迹板漂移），导致长按很难触发。
 *
 * 这里改成**按标签自身的矩形判定**：只要指针还在标签范围内（外扩少量像素），
 * 等待期间怎么移动都不会取消长按；只有指针真正移出标签，才交回父类按 tolerance 处理。
 *
 * 实现说明：dnd-kit 的 AbstractPointerSensor 把 `activated` / `handleMove` 声明为
 * TypeScript private（运行时仍是普通原型属性），因此这里用一个 any 基类绕开可见性限制，
 * 只覆写 handleMove 一个方法，其余行为（左键判定、右键忽略、点击抑制等）与内置
 * PointerSensor 完全一致。对外暴露的类型被断言为 `typeof PointerSensor`，
 * 调用侧可以像使用内置传感器一样直接传给 useSensor。
 */

import { PointerSensor } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';

/** 长按等待期间允许的额外活动范围（标签矩形向外扩，px） */
const PRESS_AREA_PADDING = 12;

type AnySensorCtor = new (props: any) => any;

const BasePointerSensor = PointerSensor as unknown as AnySensorCtor;

class TagLongPressSensorImpl extends BasePointerSensor {
    /** 按下时标签的矩形（整个长按等待期间固定不变） */
    private pressRect: DOMRect | null = null;

    constructor(props: any) {
        super(props);

        const target = props?.event?.target as Element | null;
        this.pressRect =
            target && typeof target.getBoundingClientRect === 'function'
                ? target.getBoundingClientRect()
                : null;
    }

    handleMove(event: PointerEvent): void {
        // 尚未激活 = 还在等长按计时：只要指针仍在标签范围内就不取消
        if (!this.activated && this.pressRect) {
            const point = getEventCoordinates(event);
            if (point && this.isInsidePressArea(point)) {
                return; // 吞掉这次移动，长按计时继续
            }
        }

        super.handleMove(event);
    }

    private isInsidePressArea(point: { x: number; y: number }): boolean {
        const r = this.pressRect;
        if (!r) return false;
        return (
            point.x >= r.left - PRESS_AREA_PADDING &&
            point.x <= r.right + PRESS_AREA_PADDING &&
            point.y >= r.top - PRESS_AREA_PADDING &&
            point.y <= r.bottom + PRESS_AREA_PADDING
        );
    }
}

/** 对外类型与内置 PointerSensor 一致，可直接传给 useSensor */
export const TagLongPressSensor = TagLongPressSensorImpl as unknown as typeof PointerSensor;
