/**
 * WindowManager — 窗口管理器
 *
 * 职责:
 *  1. 统一管理所有窗口（main / lyric / minimode）的创建、销毁、显示/隐藏
 *  2. 窗口尺寸与位置持久化（通过 AppConfig）
 *  3. 跨窗口 IPC 消息通信与广播
 *  4. 窗口生命周期事件（create / close）的订阅
 *
 * 设计:
 *  - 类单例，由 main/index.ts 在 app ready 后使用
 *  - 窗口配置（BrowserWindowConstructorOptions）与旧版保持一致
 *  - 通过 Map + WindowType 做统一管理，避免每类窗口一套独立方法
 */

import { app, BrowserWindow, Menu, nativeImage, screen, MessagePortMain } from 'electron';
import EventEmitter from 'eventemitter3';
import path from 'path';

import appConfig from '@infra/appConfig/main';
import i18n from '@infra/i18n/main';
import logger from '@infra/logger/main';
import windowDrag from '@infra/windowDrag/main';
import debounce from '@common/debounce';
import throttle from '@common/throttle';
import type { IWindowManager, IWindowEvents, WindowType } from '@appTypes/main/windowManager';

// ─── Forge Webpack 魔法常量 ───

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const LYRIC_WINDOW_WEBPACK_ENTRY: string;
declare const LYRIC_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const MINIMODE_WINDOW_WEBPACK_ENTRY: string;
declare const MINIMODE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// ─── 开发期调试开关 ───

/**
 * 是否自动打开 DevTools。
 *
 * 默认**不开**：开发版启动时会同时拉起主窗口和桌面歌词窗（配置里开着桌面歌词时），
 * 两个 DevTools 都是独立窗口，会把任务栏占满、还抢焦点。
 * 需要看报错时用环境变量打开：
 *   pwsh:  $env:MUSICFREE_DEVTOOLS=1; npm start
 *   或直接：npm run start:devtools
 * 打包版永远不开。
 */
function shouldAutoOpenDevTools(): boolean {
    return !app.isPackaged && process.env.MUSICFREE_DEVTOOLS === '1';
}

// ─── 图标路径 ───

function getLogoPath(): string {
    return path.resolve(globalContext.appPath.res, 'logo.png');
}

// ─── 窗口位置归一化 ───

/** 窗口至少需要多少像素可见才算"在屏幕上" */
const MIN_VISIBLE_PX = 100;

/**
 * 确保窗口在屏幕可视区域内至少有 MIN_VISIBLE_PX 像素可见。
 * 使用 clamp 逻辑将窗口位置约束在合理范围，返回是否发生了修正。
 */
function normalizeWindowPosition(win: BrowserWindow, position: { x: number; y: number }): boolean {
    const display = screen.getDisplayNearestPoint(position);
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
    const windowBounds = win.getBounds();
    const ww = windowBounds.width;
    const wh = windowBounds.height;

    const origX = position.x;
    const origY = position.y;

    // 水平: 确保窗口至少 MIN_VISIBLE_PX 在屏幕内
    const minX = dx - ww + MIN_VISIBLE_PX;
    const maxX = dx + dw - MIN_VISIBLE_PX;
    position.x = Math.max(minX, Math.min(maxX, position.x));

    // 垂直: 确保窗口至少 MIN_VISIBLE_PX 在屏幕内
    const minY = dy - wh + MIN_VISIBLE_PX;
    const maxY = dy + dh - MIN_VISIBLE_PX;
    position.y = Math.max(minY, Math.min(maxY, position.y));

    const needCorrection = position.x !== origX || position.y !== origY;
    if (needCorrection) {
        win.setBounds(
            {
                x: position.x,
                y: position.y,
                width: ww,
                height: wh,
            },
            false,
        );
    }
    return needCorrection;
}

// ─── 歌词窗口尺寸常量（与旧版保持一致） ───

const LYRIC_MIN_WIDTH = 920;
const LYRIC_MIN_HEIGHT = 92; // 60 + 16 * 2
const LYRIC_MAX_HEIGHT = 240; // 60 + 80 * 2

/** 根据字体大小推算歌词窗口高度 */
function evaluateLyricHeight(fontSize?: number): number {
    return 60 + (fontSize || 48) * 2;
}

// ─── 迷你模式窗口尺寸常量 ───

const MINIMODE_WIDTH = 420;
const MINIMODE_HEIGHT = 120;

// ─── 出帧自检（显示后兜底，见 ensureRendering） ───

/** 自检时长（毫秒） */
const FRAME_PROBE_MS = 250;
/** 自检达标的最低帧数：健康窗口 250ms 有几十帧，被掐断时 0~1 帧 */
const FRAME_PROBE_MIN = 3;
/** 重挂可见性时，hide() 与 show() 之间的间隔（毫秒） */
const RENDER_REPAIR_DELAY_MS = 120;

/** 统计 FRAME_PROBE_MS 内 requestAnimationFrame 的回调次数 */
const FRAME_PROBE_SCRIPT = `new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
        frames++;
        if (performance.now() - start < ${FRAME_PROBE_MS}) {
            requestAnimationFrame(tick);
        } else {
            resolve(frames);
        }
    };
    requestAnimationFrame(tick);
})`;

// ─── WindowManager 实现 ───

class WindowManager implements IWindowManager {
    private windows = new Map<WindowType, BrowserWindow>();
    private ee = new EventEmitter();

    constructor() {
        // ─── Config 驱动窗口：config 是唯一控制源 ───
        appConfig.onConfigUpdated((patch) => {
            if ('lyric.enableDesktopLyric' in patch) {
                if (patch['lyric.enableDesktopLyric']) {
                    this.showWindow('lyric');
                } else {
                    this.closeWindow('lyric');
                }
            }
        });
    }

    // ─── IWindowManager: 窗口生命周期 ───

    public closeWindow(windowType: WindowType): void {
        const win = this.windows.get(windowType);
        if (!win || win.isDestroyed()) return;

        win.close();
        // closed 事件中已做清理
    }

    public closeAllWindows(): void {
        for (const windowType of this.windows.keys()) {
            this.closeWindow(windowType);
        }
    }

    public showWindow(windowType: WindowType): void {
        // 互斥逻辑：主窗口和迷你模式不同时显示
        if (windowType === 'main') {
            this.closeWindow('minimode');
        } else if (windowType === 'minimode') {
            this.hideWindow('main');
        }

        const win = this.windows.get(windowType);
        if (!win || win.isDestroyed()) {
            this.ensureWindow(windowType);
            return;
        }

        if (win.isMinimized()) {
            win.restore();
        } else if (win.isVisible()) {
            win.focus();
        } else {
            win.show();
        }
        win.moveTop();

        // 主动要求重绘一帧。注意 webContents.invalidate() 只在离屏渲染
        // （offscreen）下保证产出新帧，普通窗口上它是救不回"整窗只剩底色"的
        // （实测无效，见 ensureRendering 的注释），这里保留只是为了 cost 极低。
        if (!win.webContents.isDestroyed()) {
            win.webContents.invalidate();
        }

        if (windowType === 'main') {
            win.setSkipTaskbar(false);
            // 主窗口是长期存在的那个，也是唯一出现过"显示出来但不出帧"的窗口
            this.ensureRendering(win);
        }
    }

    public hideWindow(windowType: WindowType): void {
        const win = this.windows.get(windowType);
        if (!win || win.isDestroyed()) return;
        win.hide();
    }

    public toggleWindow(windowType: WindowType): void {
        const win = this.windows.get(windowType);
        if (!win || win.isDestroyed()) {
            this.showWindow(windowType);
            return;
        }
        if (win.isVisible()) {
            this.hideWindow(windowType);
        } else {
            this.showWindow(windowType);
        }
    }

    public focusWindow(windowType: WindowType): void {
        const win = this.windows.get(windowType);
        if (!win || win.isDestroyed()) return;

        if (win.isMinimized()) {
            win.restore();
        }
        win.focus();
        win.moveTop();
    }

    // ─── IWindowManager: 窗口状态查询 ───

    public __getWindowUnsafe(windowType: WindowType): BrowserWindow | null {
        const win = this.windows.get(windowType);
        return win && !win.isDestroyed() ? win : null;
    }

    public isWindowExist(windowType: WindowType): boolean {
        const win = this.windows.get(windowType);
        return !!win && !win.isDestroyed();
    }

    public isWindowDestroyed(windowType: WindowType): boolean {
        const win = this.windows.get(windowType);
        return !win || win.isDestroyed();
    }

    public isWindowVisible(windowType: WindowType): boolean {
        const win = this.windows.get(windowType);
        return !!win && !win.isDestroyed() && win.isVisible();
    }

    // ─── IWindowManager: IPC 通信 ───

    public sendTo(type: WindowType, channel: string, ...args: unknown[]): void {
        const win = this.windows.get(type);
        if (!win || win.isDestroyed()) return;
        win.webContents.send(channel, ...args);
    }

    public broadcast(channel: string, ...args: unknown[]): void {
        for (const win of this.windows.values()) {
            if (!win.isDestroyed()) {
                win.webContents.send(channel, ...args);
            }
        }
    }

    public postMessageTo(
        type: WindowType,
        channel: string,
        data: unknown,
        ports?: MessagePortMain[],
    ): void {
        const win = this.windows.get(type);
        if (!win || win.isDestroyed()) return;
        win.webContents.postMessage(channel, data, ports);
    }

    // ─── IWindowManager: 事件订阅 ───

    public on<T extends keyof IWindowEvents>(
        event: T,
        listener: (data: IWindowEvents[T]) => void,
    ): void {
        this.ee.on(event, listener);
    }

    // ─── IWindowManager: 迷你模式 ───

    public enterMinimode(): void {
        if (this.isMinimode()) return;
        this.showWindow('minimode');
    }

    public exitMinimode(): void {
        if (!this.isMinimode()) return;
        this.showWindow('main');
    }

    public isMinimode(): boolean {
        return this.isWindowVisible('minimode');
    }

    /**
     * 同步窗口原生底色（由主题切换时渲染进程上报）。
     *
     * 跳过透明窗口（迷你模式 / 桌面歌词）：它们靠 CSS 自己画，设底色会破坏圆角透明。
     */
    public setWindowBackgroundColor(color: string): void {
        const mainWindow = this.windows.get('main');
        if (!mainWindow || mainWindow.isDestroyed()) return;

        try {
            mainWindow.setBackgroundColor(color);
            logger.info('[WindowManager] 主窗口底色已同步为', color);
        } catch (e) {
            logger.warn('[WindowManager] 同步窗口底色失败', e);
        }
    }

    // ─── 私有 ───

    /** 确保窗口存在，已存在则聚焦，不存在则创建 */
    private ensureWindow(windowType: WindowType): void {
        const existing = this.windows.get(windowType);
        if (existing && !existing.isDestroyed()) {
            this.focusWindow(windowType);
            return;
        }

        switch (windowType) {
            case 'main':
                this.createMainWindow();
                break;
            case 'lyric':
                this.createLyricWindow();
                break;
            case 'minimode':
                this.createMiniModeWindow();
                break;
        }
    }

    private emit<T extends keyof IWindowEvents>(event: T, data: IWindowEvents[T]): void {
        this.ee.emit(event, data);
    }

    /**
     * 显示之后做一次极短的"出帧自检"，被掐断就重挂一次可见性。
     *
     * 背景（2026-09 实测，现象：从迷你模式点托盘图标回主界面，主窗口整窗黑屏）：
     *  - 黑屏时窗口是可见的，画面上 100% 都是窗口底色 #121212
     *    （也就是合成器一帧内容都没呈现出来）；
     *  - 渲染进程是活的：DOM 完好、document.visibilityState === 'visible'、
     *    document.hasFocus() 正常，但 rAF 600ms 只跑 2 帧（健康时 74~120 帧），
     *    即浏览器侧把这一页的帧产出停掉了；
     *  - 对照实验：webContents.invalidate()、改窗口尺寸（1px）、移动窗口（1px）、
     *    外部 ShowWindow 隐藏+显示，全都救不回来；只有 Electron 自己的
     *    hide() → show() 能恢复（rAF 2 → 74，画面 meanLum 18 → 27.4），
     *    这也正是「进迷你模式再展开主界面」能手动恢复的原因。
     *
     * 所以这里不猜触发条件，只在显示后自检一次：正常情况下 250ms 内会有几十帧，
     * 自检直接通过、不做任何多余动作；只有真的不出帧（< FRAME_PROBE_MIN 帧）时，
     * 才补一次 hide() → show() 把可见性重新挂上（此时窗口本来就是黑的，用户无感）。
     */
    private ensureRendering(win: BrowserWindow): void {
        const contents = win.webContents;
        if (contents.isDestroyed()) return;

        contents
            .executeJavaScript(FRAME_PROBE_SCRIPT, true)
            .then((frames: unknown) => {
                if (win.isDestroyed() || contents.isDestroyed() || !win.isVisible()) return;
                if (typeof frames !== 'number' || frames >= FRAME_PROBE_MIN) return;

                logger.warn(
                    `[WindowManager] 主窗口显示后没有出帧（${frames} 帧/${FRAME_PROBE_MS}ms），重挂可见性`,
                );
                // hide 和 show 之间必须留出时间：同步连着调用会被合并成一次
                // 可见性变更（等于没做），只有真正经历过"隐藏"的 hide→show
                // 才能把帧产出重新挂上（此时窗口本来就是黑的，用户看不到闪烁）
                win.hide();
                setTimeout(() => {
                    if (win.isDestroyed() || contents.isDestroyed()) return;
                    win.show();
                    win.focus();
                    win.moveTop();
                }, RENDER_REPAIR_DELAY_MS);
            })
            .catch(() => {
                // 页面正在加载 / 窗口被销毁时忽略，自检失败不影响正常显示
            });
    }

    // ─── 私有: 窗口注册 & 清理 ───

    private registerWindow(windowType: WindowType, win: BrowserWindow): void {
        this.windows.set(windowType, win);

        win.webContents.on('context-menu', (_event, params) => {
            if (!params.isEditable) return;

            const { editFlags } = params;
            Menu.buildFromTemplate([
                { label: i18n.t('common.cut'), role: 'cut', enabled: editFlags.canCut },
                { label: i18n.t('common.copy'), role: 'copy', enabled: editFlags.canCopy },
                { label: i18n.t('common.paste'), role: 'paste', enabled: editFlags.canPaste },
                { type: 'separator' },
                {
                    label: i18n.t('common.select_all'),
                    role: 'selectAll',
                    enabled: editFlags.canSelectAll,
                },
            ]).popup({ window: win });
        });

        win.on('closed', () => {
            this.windows.delete(windowType);
            this.emit('close', { windowType });
        });

        this.emit('create', { windowType });
    }

    /**************************** Main Window ***************************/

    private createMainWindow(): void {
        // 清理旧窗口
        const old = this.windows.get('main');
        if (old) {
            old.removeAllListeners();
            if (!old.isDestroyed()) {
                old.close();
                old.destroy();
            }
            this.windows.delete('main');
        }

        const initSize = appConfig.getConfigByKey('private.mainWindowSize');

        const mainWindow = new BrowserWindow({
            height: initSize?.height ?? 860,
            width: initSize?.width ?? 1290,
            minHeight: 760,
            minWidth: 1080,
            webPreferences: {
                preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
                nodeIntegration: true,
                nodeIntegrationInWorker: true,
                webSecurity: false,
                sandbox: false,
                webviewTag: true,
                // 隐藏到托盘 / 切迷你模式时不要节流渲染：
                // 被节流后合成器可能一直不产出新帧，恢复显示时就是一片空白（黑/白屏）
                backgroundThrottling: false,
            },
            frame: false,
            icon: nativeImage.createFromPath(getLogoPath()),
            // 深色底：窗口在「还没绘制出第一帧」时露出的就是它。
            // Electron 默认是白色，隐藏较久再显示（或从迷你模式切回来）时
            // 合成器可能还没送出新的帧，整窗就是一片白。
            // 注意：主题切换后渲染进程会把 --color-bg-base 上报过来覆盖它
            // （见 setWindowBackgroundColor），所以浅色主题下也不会是黑的。
            backgroundColor: '#121212',
        });

        // 渲染进程异常结束（崩溃 / 被系统杀掉）时自动重载：
        // 否则窗口会一直停在「只有底色」的空白状态，用户看到的也是黑屏
        mainWindow.webContents.on('render-process-gone', (_event, details) => {
            const crashReasons = [
                'crashed',
                'oom',
                'abnormal-exit',
                'launch-failed',
                'integrity-failure',
            ];
            if (!crashReasons.includes(details.reason)) return;

            logger.error('[WindowManager] 主窗口渲染进程异常结束，自动重载', details.reason);
            if (!mainWindow.isDestroyed()) {
                mainWindow.reload();
            }
        });

        // 窗口尺寸持久化（防抖 300ms）
        const updateWindowSize = debounce(() => {
            if (mainWindow.isDestroyed()) return;
            const [w, h] = mainWindow.getSize();
            appConfig.setConfig({
                'private.mainWindowSize': { width: w, height: h },
            });
        }, 300);
        mainWindow.on('resize', updateWindowSize);

        // 加载主界面（首屏路由由 renderer 侧 React Router index route 处理）
        mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

        // 开发模式下自动打开 DevTools（默认不开，见 shouldAutoOpenDevTools）
        if (shouldAutoOpenDevTools()) {
            mainWindow.on('ready-to-show', () => {
                mainWindow.webContents.openDevTools();
            });
        }

        // HTTP Header 注入（兼容插件请求 hack）
        mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
            try {
                const url = new URL(details.url);
                const setHeadersRaw = url.searchParams.get('_setHeaders');
                if (!setHeadersRaw) {
                    throw new Error('No need to hack');
                }

                const originalHeaders = details.requestHeaders ?? {};
                const patchHeaders: Record<string, string> = JSON.parse(
                    decodeURIComponent(setHeadersRaw),
                );
                const requestHeaders: Record<string, string> = {};

                for (const k in originalHeaders) {
                    requestHeaders[k.toLowerCase()] = originalHeaders[k];
                }
                for (const k in patchHeaders) {
                    requestHeaders[k.toLowerCase()] = patchHeaders[k];
                }

                callback({ requestHeaders });
            } catch {
                callback({ requestHeaders: details.requestHeaders });
            }
        });

        // 关闭行为: 最小化到托盘
        mainWindow.on('close', (e) => {
            if (appConfig.getConfigByKey('normal.closeBehavior') === 'minimize') {
                e.preventDefault();
                mainWindow.hide();
                if (process.platform === 'win32') {
                    mainWindow.setSkipTaskbar(true);
                }
            }
        });

        this.registerWindow('main', mainWindow);
    }

    /**************************** Lyric Window ***************************/

    private createLyricWindow(): void {
        const initPosition = appConfig.getConfigByKey('private.lyricWindowPosition');
        const initSize = appConfig.getConfigByKey('private.lyricWindowSize');

        let width = Math.max(initSize?.width ?? LYRIC_MIN_WIDTH, LYRIC_MIN_WIDTH);
        let height = evaluateLyricHeight(appConfig.getConfigByKey('lyric.fontSize') ?? undefined);
        let lyricMaxWidth = 0;

        const lyricWindow = new BrowserWindow({
            height,
            width,
            x: initPosition?.x,
            y: initPosition?.y,
            transparent: true,
            webPreferences: {
                preload: LYRIC_WINDOW_PRELOAD_WEBPACK_ENTRY,
                nodeIntegration: true,
                webSecurity: false,
                sandbox: false,
            },
            minWidth: LYRIC_MIN_WIDTH,
            minHeight: LYRIC_MIN_HEIGHT,
            maxHeight: LYRIC_MAX_HEIGHT,
            resizable: true,
            frame: false,
            thickFrame: true,
            skipTaskbar: true,
            alwaysOnTop: appConfig.getConfigByKey('lyric.alwaysOnTop') ?? true,
            icon: nativeImage.createFromPath(getLogoPath()),
        });

        // 动态限制最大宽度为当前显示器宽度
        const display = screen.getDisplayNearestPoint(lyricWindow.getBounds());
        lyricMaxWidth = display.bounds.width;
        lyricWindow.setMaximumSize(lyricMaxWidth, LYRIC_MAX_HEIGHT);

        // 加载歌词页面
        lyricWindow.loadURL(LYRIC_WINDOW_WEBPACK_ENTRY);

        if (shouldAutoOpenDevTools()) {
            // 桌面歌词是无边框 + 置顶小窗：dock 进去的 DevTools 会挤在窗口里，
            // 既没有关闭按钮也点不到，只能用独立窗口打开
            lyricWindow.webContents.openDevTools({ mode: 'undocked' });
        }

        // 尺寸变化持久化 + 反推字号
        // width/height 立即同步更新，保证 getWindowSize 始终准确（拖拽期间 setBounds 依赖此值）
        // 配置写入走节流，避免高频写文件
        let isResizingFromConfig = false;
        const persistLyricSize = throttle(() => {
            if (lyricWindow.isDestroyed()) return;
            const fontSize = Math.max(Math.min(Math.floor((height - 60) / 2), 80), 12);
            appConfig.setConfig({
                'lyric.fontSize': fontSize,
                'private.lyricWindowSize': { width, height },
            });
        }, 150);
        lyricWindow.on('resize', () => {
            if (windowDrag.isDragging(lyricWindow) || isResizingFromConfig) {
                return;
            }
            const [wWidth, wHeight] = lyricWindow.getSize();
            width = wWidth;
            height = wHeight;
            persistLyricSize();
        });

        // 拖拽支持
        windowDrag.setWindowDraggable(lyricWindow, {
            width,
            height,
            getWindowSize: () => ({ width, height }),
            onDragEnd(point) {
                if (!point) return;
                // 归一化位置，确保拖拽结束后窗口仍在屏幕可视区域内
                normalizeWindowPosition(lyricWindow, point);
                appConfig.setConfig({ 'private.lyricWindowPosition': point });
                // 检测是否切换了显示器，更新 maxWidth
                const currentDisplay = screen.getDisplayNearestPoint(point);
                if (currentDisplay.bounds.width !== lyricMaxWidth) {
                    lyricMaxWidth = currentDisplay.bounds.width;
                    lyricWindow.setMaximumSize(lyricMaxWidth, LYRIC_MAX_HEIGHT);
                }
            },
        });

        // 监听歌词相关配置变更
        const onConfigUpdated = (
            patch: Record<string, unknown>,
            _config: unknown,
            source: string,
        ) => {
            if (lyricWindow.isDestroyed()) return;

            // fontSize: 仅响应来自渲染进程的变更，主进程 resize 反推的字号不需要再 setSize
            if (source === 'renderer' && 'lyric.fontSize' in patch && patch['lyric.fontSize']) {
                const newHeight = evaluateLyricHeight(patch['lyric.fontSize'] as number);
                if (newHeight !== height) {
                    height = newHeight;
                    isResizingFromConfig = true;
                    const bounds = lyricWindow.getBounds();
                    lyricWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
                    isResizingFromConfig = false;
                }
            }

            // lockLyric: 运行时切换鼠标穿透
            if ('lyric.lockLyric' in patch) {
                if (patch['lyric.lockLyric']) {
                    lyricWindow.setIgnoreMouseEvents(true, { forward: true });
                } else {
                    lyricWindow.setIgnoreMouseEvents(false);
                }
            }

            // alwaysOnTop: 运行时切换置顶
            if ('lyric.alwaysOnTop' in patch) {
                lyricWindow.setAlwaysOnTop(!!patch['lyric.alwaysOnTop']);
            }
        };
        appConfig.onConfigUpdated(onConfigUpdated);
        lyricWindow.on('closed', () => {
            appConfig.offConfigUpdated(onConfigUpdated);
        });

        // 初始化位置归一化 & 锁定状态
        lyricWindow.once('ready-to-show', () => {
            // 无论有无保存位置，都确保窗口在可视区域内
            const pos = initPosition
                ? { ...initPosition }
                : { x: lyricWindow.getBounds().x, y: lyricWindow.getBounds().y };
            if (normalizeWindowPosition(lyricWindow, pos)) {
                appConfig.setConfig({ 'private.lyricWindowPosition': pos });
            }

            const locked = appConfig.getConfigByKey('lyric.lockLyric');
            if (locked) {
                lyricWindow.setIgnoreMouseEvents(true, { forward: true });
            }
        });

        if (process.platform === 'darwin') {
            (lyricWindow as any).invalidateShadow?.();
        }

        this.registerWindow('lyric', lyricWindow);
    }

    /**************************** MiniMode Window ***************************/

    private createMiniModeWindow(): void {
        const initPosition = appConfig.getConfigByKey('private.minimodeWindowPosition');

        const miniWindow = new BrowserWindow({
            height: MINIMODE_HEIGHT,
            width: MINIMODE_WIDTH,
            x: initPosition?.x,
            y: initPosition?.y,
            webPreferences: {
                preload: MINIMODE_WINDOW_PRELOAD_WEBPACK_ENTRY,
                nodeIntegration: true,
                webSecurity: false,
                sandbox: false,
            },
            transparent: true,
            resizable: false,
            frame: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            icon: nativeImage.createFromPath(getLogoPath()),
        });

        // 加载迷你模式页面
        miniWindow.loadURL(MINIMODE_WINDOW_WEBPACK_ENTRY);

        if (!app.isPackaged) {
            // 同桌面歌词：迷你模式窗口无边框 + 置顶 + 不可缩放，
            // dock 进去的 DevTools 没有关闭入口，改用独立窗口
            miniWindow.on('ready-to-show', () => {
                miniWindow.webContents.openDevTools({ mode: 'undocked' });
            });
        }

        // 拖拽支持
        windowDrag.setWindowDraggable(miniWindow, {
            width: MINIMODE_WIDTH,
            height: MINIMODE_HEIGHT,
            onDragEnd(point) {
                if (!point) return;
                normalizeWindowPosition(miniWindow, point);
                appConfig.setConfig({ 'private.minimodeWindowPosition': point });
            },
        });

        // 初始化位置归一化
        miniWindow.once('ready-to-show', () => {
            const pos = initPosition
                ? { ...initPosition }
                : { x: miniWindow.getBounds().x, y: miniWindow.getBounds().y };
            if (normalizeWindowPosition(miniWindow, pos)) {
                appConfig.setConfig({ 'private.minimodeWindowPosition': pos });
            }
        });

        this.registerWindow('minimode', miniWindow);
    }
}

const windowManager = new WindowManager();
export default windowManager;
