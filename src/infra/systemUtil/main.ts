/**
 * systemUtil — 主进程层
 *
 * 职责:
 *  1. 应用控制（退出、缓存管理、版本检查）
 *  2. 窗口控制（最小化、最大化、显示/隐藏、歌词/迷你模式窗口）
 *  3. Shell 操作（打开 URL、打开路径、在文件管理器中定位）
 *  4. 原生 Dialog（打开/保存文件对话框）
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import fsp from 'fs/promises';
import axios from 'axios';
import { compare } from 'compare-versions';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type { IUpdateInfo, IPopupNativeMenuParams } from '@appTypes/infra/systemUtil';
import appSync from '@infra/appSync/main';
import { IPC, UPSTREAM_UPDATE_SOURCES } from './common/constant';

class SystemUtil {
    private windowManager!: IWindowManager;
    private isSetup = false;

    public setup(windowManager: IWindowManager) {
        if (this.isSetup) return;

        this.windowManager = windowManager;

        this.setupAppHandlers();
        this.setupWindowHandlers();
        this.setupShellHandlers();
        this.setupDialogHandlers();
        this.setupMenuHandlers();

        this.isSetup = true;
    }

    // ─── App ───

    private setupAppHandlers() {
        ipcMain.on(IPC.EXIT_APP, () => {
            this.windowManager.closeAllWindows();
            app.exit(0);
        });

        ipcMain.handle(IPC.GET_CACHE_SIZE, async (evt) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (win) {
                return win.webContents.session.getCacheSize?.();
            }
            return NaN;
        });

        ipcMain.on(IPC.CLEAR_CACHE, (evt) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (win) {
                win.webContents.session.clearCache?.();
            }
        });

        ipcMain.handle(IPC.CHECK_UPDATE, async () => {
            return this.checkUpdate();
        });
    }

    // ─── Window ───

    private setupWindowHandlers() {
        ipcMain.on(IPC.MINIMIZE_WINDOW, (evt, { skipTaskBar }) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (!win) return;

            if (skipTaskBar) {
                win.hide();
                win.setSkipTaskbar(true);
            } else {
                win.minimize();
            }
        });

        ipcMain.on(IPC.SHOW_MAIN_WINDOW, () => {
            this.windowManager.showWindow('main');
        });

        ipcMain.on(IPC.TOGGLE_MAXIMIZE, (evt) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (!win) return;

            if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        });

        ipcMain.on(IPC.TOGGLE_VISIBLE, (evt) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (!win) return;

            if (win.isMinimized() || !win.isVisible()) {
                win.show();
            } else {
                win.hide();
                win.setSkipTaskbar(true);
            }
        });

        ipcMain.on(IPC.IGNORE_MOUSE_EVENT, (evt, ignore: boolean) => {
            const targetWindow = BrowserWindow.fromWebContents(evt.sender);
            if (!targetWindow) return;

            targetWindow.setIgnoreMouseEvents(ignore, { forward: true });
        });

        ipcMain.on(IPC.ENTER_MINIMODE, () => {
            this.windowManager.enterMinimode();
        });

        ipcMain.on(IPC.EXIT_MINIMODE, () => {
            this.windowManager.exitMinimode();
        });

        ipcMain.on(IPC.TOGGLE_MINIMODE, () => {
            if (this.windowManager.isMinimode()) {
                this.windowManager.exitMinimode();
            } else {
                this.windowManager.enterMinimode();
            }
        });
    }

    // ─── Shell ───

    private setupShellHandlers() {
        ipcMain.on(IPC.OPEN_EXTERNAL, (_, url: string) => {
            shell.openExternal(url);
        });

        ipcMain.on(IPC.OPEN_PATH, (_, path: string) => {
            shell.openPath(path);
        });

        ipcMain.handle(IPC.SHOW_ITEM_IN_FOLDER, async (_, path: string) => {
            try {
                await fsp.stat(path);
                shell.showItemInFolder(path);
                return true;
            } catch {
                return false;
            }
        });
    }

    // ─── Dialog ───

    private setupDialogHandlers() {
        ipcMain.handle(IPC.SHOW_OPEN_DIALOG, async (evt, options: Electron.OpenDialogOptions) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (!win) {
                throw new Error('No window available');
            }
            return dialog.showOpenDialog(win, options);
        });

        ipcMain.handle(IPC.SHOW_SAVE_DIALOG, async (evt, options: Electron.SaveDialogOptions) => {
            const win = BrowserWindow.fromWebContents(evt.sender);
            if (!win) {
                throw new Error('No window available');
            }
            return dialog.showSaveDialog(win, options);
        });
    }

    // ─── Menu ───

    /**
     * 弹出系统原生菜单。
     *
     * 迷你窗口只有 420×120，应用内菜单会被窗口边界裁掉，所以由渲染进程把菜单项
     * （id + 文案）传上来，主进程用 Menu.popup 弹系统菜单；点击后把 id 通过
     * appSync 指令发回主窗口渲染进程执行——回调闭包只在渲染进程里，
     * 主进程拿不到，所以只做“显示 + 回传”。
     */
    private setupMenuHandlers() {
        ipcMain.on(IPC.POPUP_NATIVE_MENU, (evt, params: IPopupNativeMenuParams) => {
            const sender = BrowserWindow.fromWebContents(evt.sender);
            const items = params?.items ?? [];
            if (!sender || sender.isDestroyed() || !items.length) return;

            const target =
                params.targetWindow && params.targetWindow !== 'sender'
                    ? (this.windowManager.__getWindowUnsafe(params.targetWindow) ?? sender)
                    : sender;

            const template: Electron.MenuItemConstructorOptions[] = items.map((item) => {
                if (item.type === 'separator') {
                    return { type: 'separator' };
                }
                return {
                    label: item.label ?? '',
                    enabled: item.enabled !== false,
                    click: () => {
                        if (item.id) {
                            appSync.sendCommand('run-current-music-menu-action', item.id);
                        }
                    },
                };
            });

            const menu = Menu.buildFromTemplate(template);
            menu.popup({
                window: target && !target.isDestroyed() ? target : sender,
                ...(typeof params.x === 'number' && typeof params.y === 'number'
                    ? { x: Math.round(params.x), y: Math.round(params.y) }
                    : {}),
            });
        });
    }

    // ─── 内部方法 ───

    /**
     * 检查**原版（上游）**更新。
     *
     * 关于页把它放在「原版信息」一栏里，按钮文案是「获取原版更新」——
     * 本变体的更新源还没定（见 common/constant.ts 的 FORK_UPDATE_SOURCES）。
     */
    private async checkUpdate(): Promise<IUpdateInfo> {
        const currentVersion = app.getVersion();
        const updateInfo: IUpdateInfo = { version: currentVersion };

        for (const source of UPSTREAM_UPDATE_SOURCES) {
            try {
                const { data: rawInfo } = await axios.get(source, { timeout: 10000 });
                if (rawInfo?.version && compare(rawInfo.version, currentVersion, '>')) {
                    updateInfo.update = rawInfo;
                    return updateInfo;
                }
            } catch {
                // 当前源不可用，尝试下一个
            }
        }

        return updateInfo;
    }
}

const systemUtil = new SystemUtil();
export default systemUtil;
