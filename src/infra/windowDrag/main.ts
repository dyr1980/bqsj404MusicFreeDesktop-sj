/**
 * windowDrag — 主进程层
 *
 * 职责:
 *  1. Win32: 通过 hookWindowMessage 拦截原生鼠标消息实现拖拽
 *  2. macOS/Linux: 通过 IPC 接收拖拽起始偏移，轮询光标位置移动窗口
 *  3. 管理已注册窗口的生命周期，窗口关闭时自动清理
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import type { IWindowDragOptions, IPoint } from '@appTypes/infra/windowDrag';
import { IPC, DRAG_THRESHOLD } from './common/constant';

// ─── Win32 原生消息常量 ───

/** https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousemove */
const WM_MOUSEMOVE = 0x0200;
/** https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-lbuttondown */
const WM_LBUTTONDOWN = 0x0201;
/** https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-lbuttonup */
const WM_LBUTTONUP = 0x0202;
/** 左键按下状态位 */
const MK_LBUTTON = 0x0001;

// ─── Win32 拖拽实现 ───

/**
 * Win32 平台：通过拦截原生窗口消息实现全窗口拖拽。
 *
 * 直接在 main 进程处理 WM_MOUSEMOVE/WM_LBUTTONUP，
 * 延迟足够位移后才开始移动窗口，小位移视为点击不干扰事件。
 *
 * 位置计算全部走 DIP（`screen.getCursorScreenPoint()` + `getPosition()`）：
 * WM_MOUSEMOVE 的 lParam 是**物理像素**的客户区坐标，而 getPosition/setBounds
 * 用的是 DIP，两者在高 DPI（如 200% 缩放）下差一倍，混用会让窗口来回过冲、
 * 拖起来持续抖动。所以这里不解析 lParam，只用光标绝对位置减去按下时的抓取偏移。
 *
 * 参考: https://github.com/electron/electron/issues/1354#issuecomment-1356330873
 */
function makeWin32WindowFullyDraggable(
    browserWindow: BrowserWindow,
    options: IWindowDragOptions,
    draggingSet: Set<BrowserWindow>,
    suspendedSet: Set<BrowserWindow>,
): void {
    const { height, width, getWindowSize, onDragEnd } = options;

    let dragging = false;
    let pastThreshold = false;
    let cachePosition: IPoint | null = null;
    /** 按下瞬间：光标相对窗口左上角的偏移（DIP），拖拽期间保持不变 */
    const grabOffset: IPoint = { x: 0, y: 0 };
    /** 按下瞬间的光标屏幕坐标（DIP），用于判断是否超过拖拽阈值 */
    const pressPoint: IPoint = { x: 0, y: 0 };
    let dragSize = { width, height };

    browserWindow.hookWindowMessage(WM_LBUTTONUP, () => {
        dragging = false;
        draggingSet.delete(browserWindow);
        if (pastThreshold && cachePosition !== null) {
            onDragEnd?.(cachePosition);
        }
        pastThreshold = false;
        cachePosition = null;
    });

    // 按下瞬间就把抓取偏移记下来。
    // 如果等到第一次 WM_MOUSEMOVE 才记，光标已经移动了一段距离，
    // 窗口会永久落后这段距离（快速拖动时肉眼可见）。
    browserWindow.hookWindowMessage(WM_LBUTTONDOWN, () => {
        if (browserWindow.isDestroyed() || suspendedSet.has(browserWindow)) {
            return;
        }

        const cursor = screen.getCursorScreenPoint();
        const [winX, winY] = browserWindow.getPosition();

        grabOffset.x = cursor.x - winX;
        grabOffset.y = cursor.y - winY;
        pressPoint.x = cursor.x;
        pressPoint.y = cursor.y;

        const size = getWindowSize ? getWindowSize() : { width, height };
        dragSize = { width: size.width, height: size.height };

        dragging = true;
        pastThreshold = false;
    });

    browserWindow.hookWindowMessage(WM_MOUSEMOVE, (wParam: Buffer) => {
        if (browserWindow.isDestroyed()) {
            return;
        }

        // 滑条等控件按下时，渲染进程会临时关掉拖拽
        if (suspendedSet.has(browserWindow)) {
            dragging = false;
            pastThreshold = false;
            return;
        }

        const wParamNumber = wParam.readInt16LE(0);
        if (!(wParamNumber & MK_LBUTTON)) {
            return;
        }

        const cursor = screen.getCursorScreenPoint();

        if (!dragging) {
            // 正常情况下 WM_LBUTTONDOWN 已经初始化过了；
            // 若那次按下没收到（例如窗口未激活时首次点击被系统拿去激活），
            // 退回到「第一次移动时记录」——能拖，只是会落后这一小段距离
            const [winX, winY] = browserWindow.getPosition();
            grabOffset.x = cursor.x - winX;
            grabOffset.y = cursor.y - winY;
            pressPoint.x = cursor.x;
            pressPoint.y = cursor.y;

            const size = getWindowSize ? getWindowSize() : { width, height };
            dragSize = { width: size.width, height: size.height };

            dragging = true;
            pastThreshold = false;
            return;
        }

        // 未超过阈值时不移动窗口，避免干扰点击
        if (!pastThreshold) {
            if (
                Math.abs(cursor.x - pressPoint.x) + Math.abs(cursor.y - pressPoint.y) <
                DRAG_THRESHOLD
            ) {
                return;
            }
            pastThreshold = true;
            draggingSet.add(browserWindow);
        }

        cachePosition = {
            x: cursor.x - grabOffset.x,
            y: cursor.y - grabOffset.y,
        };

        browserWindow.setBounds({
            x: cachePosition.x,
            y: cachePosition.y,
            height: dragSize.height,
            width: dragSize.width,
        });
    });
}

// ─── 模块实现 ───

/** 安全超时：防止渲染进程崩溃导致 interval 永远运行 */
const MAX_DRAG_DURATION = 60_000; // 60 秒

class WindowDrag {
    private isSetup = false;

    /** 已注册拖拽的窗口及其选项 */
    private registeredWindows = new Map<BrowserWindow, IWindowDragOptions>();

    /** macOS/Linux: 拖拽期间的光标轮询定时器 */
    private dragIntervals = new Map<BrowserWindow, ReturnType<typeof setInterval>>();

    /** macOS/Linux: 安全超时定时器 */
    private dragTimeouts = new Map<BrowserWindow, ReturnType<typeof setTimeout>>();

    /** Win32: 正在拖拽中的窗口集合 */
    private win32DraggingWindows = new Set<BrowserWindow>();

    /** 被渲染进程临时关掉拖拽的窗口（滑条按下期间） */
    private suspendedWindows = new Set<BrowserWindow>();

    public setup(): void {
        if (this.isSetup) {
            return;
        }

        this.registerIpcHandlers();

        this.isSetup = true;
    }

    /**
     * 为指定窗口启用全窗口拖拽。
     *
     * - Win32: 通过 hookWindowMessage 拦截原生消息，无需 IPC
     * - macOS/Linux: 渲染进程检测鼠标拖拽后通知主进程轮询光标
     */
    public setWindowDraggable(window: BrowserWindow, options: IWindowDragOptions): void {
        if (process.platform === 'win32') {
            makeWin32WindowFullyDraggable(
                window,
                options,
                this.win32DraggingWindows,
                this.suspendedWindows,
            );
        } else {
            this.registeredWindows.set(window, options);
        }

        // 窗口关掉时清理各集合，避免残留（挂载在这里两种情况都能覆盖）
        window.on('closed', () => {
            this.clearDragInterval(window);
            this.registeredWindows.delete(window);
            this.win32DraggingWindows.delete(window);
            this.suspendedWindows.delete(window);
        });
    }

    /**
     * 判断指定窗口是否正在被拖拽。
     */
    public isDragging(win: BrowserWindow): boolean {
        if (process.platform === 'win32') {
            return this.win32DraggingWindows.has(win);
        }
        return this.dragIntervals.has(win);
    }

    private registerIpcHandlers(): void {
        // macOS/Linux: 渲染进程通知拖拽开始，主进程轮询光标位置移动窗口
        ipcMain.on(IPC.START_DRAG, (_evt, offset: IPoint) => {
            const win = BrowserWindow.fromWebContents(_evt.sender);
            if (!win || win.isDestroyed()) return;

            const metadata = this.registeredWindows.get(win);
            if (!metadata) return;

            this.clearDragInterval(win);

            // 记录拖拽开始时的窗口尺寸，拖拽期间不变
            let dragWidth = metadata.width;
            let dragHeight = metadata.height;
            if (metadata.getWindowSize) {
                const size = metadata.getWindowSize();
                dragWidth = size.width;
                dragHeight = size.height;
            }

            const interval = setInterval(() => {
                if (win.isDestroyed()) {
                    this.clearDragInterval(win);
                    return;
                }
                const cursor = screen.getCursorScreenPoint();
                win.setBounds({
                    x: cursor.x - offset.x,
                    y: cursor.y - offset.y,
                    width: dragWidth,
                    height: dragHeight,
                });
            }, 16); // ~60fps

            this.dragIntervals.set(win, interval);

            // 安全超时：防止渲染进程崩溃/未发 stop 导致 interval 泄漏
            const timeout = setTimeout(() => {
                this.clearDragInterval(win);
            }, MAX_DRAG_DURATION);
            this.dragTimeouts.set(win, timeout);
        });

        // macOS/Linux: 拖拽结束，停止轮询并通知回调
        ipcMain.on(IPC.STOP_DRAG, (_evt) => {
            const win = BrowserWindow.fromWebContents(_evt.sender);
            if (!win) return;

            this.clearDragInterval(win);

            const metadata = this.registeredWindows.get(win);
            if (!metadata || win.isDestroyed()) return;

            const [x, y] = win.getPosition();
            metadata.onDragEnd?.({ x, y });
        });

        // 渲染进程临时开关本窗口的拖拽（滑条按下 / 松开）
        ipcMain.on(IPC.SET_DRAG_ENABLED, (_evt, enabled: boolean) => {
            const win = BrowserWindow.fromWebContents(_evt.sender);
            if (!win || win.isDestroyed()) return;

            if (enabled) {
                this.suspendedWindows.delete(win);
            } else {
                this.suspendedWindows.add(win);
                // 已经进入拖拽状态的，立刻退出，否则滑条拖动期间窗口还会跟着走
                this.win32DraggingWindows.delete(win);
            }
        });
    }

    private clearDragInterval(win: BrowserWindow): void {
        const interval = this.dragIntervals.get(win);
        if (interval) {
            clearInterval(interval);
            this.dragIntervals.delete(win);
        }
        const timeout = this.dragTimeouts.get(win);
        if (timeout) {
            clearTimeout(timeout);
            this.dragTimeouts.delete(win);
        }
    }
}

const windowDrag = new WindowDrag();
export default windowDrag;
