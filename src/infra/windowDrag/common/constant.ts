/** IPC 通道 */
export const IPC = {
    START_DRAG: '@infra/window-drag/start-drag',
    STOP_DRAG: '@infra/window-drag/stop-drag',
    /**
     * 开关本窗口的拖拽能力。
     *
     * 迷你窗口整块都是拖拽区，但音量条 / 进度条这类滑条要能拖自己的值，
     * 按下时先关掉窗口拖拽，松开再打开。
     */
    SET_DRAG_ENABLED: '@infra/window-drag/set-drag-enabled',
} as const;

/** 拖拽阈值（像素），小于此值视为点击而非拖拽 */
export const DRAG_THRESHOLD = 5;

/** contextBridge key */
export const CONTEXT_BRIDGE_KEY = '@infra/window-drag';
