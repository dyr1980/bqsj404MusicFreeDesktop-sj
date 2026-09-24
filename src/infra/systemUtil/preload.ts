/**
 * systemUtil — Preload 层
 *
 * 通过 contextBridge 向渲染进程暴露系统操作 API。
 * 所有窗口共用此 preload。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, CONTEXT_BRIDGE_KEY } from './common/constant';

const mod = {
    app: {
        exitApp: () => ipcRenderer.send(IPC.EXIT_APP),
        getCacheSize: (): Promise<number> => ipcRenderer.invoke(IPC.GET_CACHE_SIZE),
        clearCache: () => ipcRenderer.send(IPC.CLEAR_CACHE),
        checkUpdate: (): Promise<unknown> => ipcRenderer.invoke(IPC.CHECK_UPDATE),
    },
    window: {
        minimizeWindow: (skipTaskBar?: boolean) =>
            ipcRenderer.send(IPC.MINIMIZE_WINDOW, { skipTaskBar }),
        showMainWindow: () => ipcRenderer.send(IPC.SHOW_MAIN_WINDOW),
        toggleMaximize: () => ipcRenderer.send(IPC.TOGGLE_MAXIMIZE),
        toggleVisible: () => ipcRenderer.send(IPC.TOGGLE_VISIBLE),
        ignoreMouseEvent: (ignore: boolean) => ipcRenderer.send(IPC.IGNORE_MOUSE_EVENT, ignore),
        enterMinimode: () => ipcRenderer.send(IPC.ENTER_MINIMODE),
        exitMinimode: () => ipcRenderer.send(IPC.EXIT_MINIMODE),
        toggleMinimode: () => ipcRenderer.send(IPC.TOGGLE_MINIMODE),
    },
    shell: {
        openExternal: (url: string) => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
        openPath: (path: string) => ipcRenderer.send(IPC.OPEN_PATH, path),
        showItemInFolder: (path: string): Promise<boolean> =>
            ipcRenderer.invoke(IPC.SHOW_ITEM_IN_FOLDER, path),
    },
    dialog: {
        showOpenDialog: (
            options: Electron.OpenDialogOptions,
        ): Promise<Electron.OpenDialogReturnValue> =>
            ipcRenderer.invoke(IPC.SHOW_OPEN_DIALOG, options),
        showSaveDialog: (
            options: Electron.SaveDialogOptions,
        ): Promise<Electron.SaveDialogReturnValue> =>
            ipcRenderer.invoke(IPC.SHOW_SAVE_DIALOG, options),
    },
    menu: {
        /**
         * 弹出系统原生菜单。
         *
         * 迷你窗口只有 420×120，应用内菜单会被窗口裁掉，只能借系统弹窗。
         * 点击哪一项由主进程通过 appSync 指令回传，渲染进程再执行对应动作。
         */
        popupNativeMenu: (params: unknown) => ipcRenderer.send(IPC.POPUP_NATIVE_MENU, params),
    },
};

contextBridge.exposeInMainWorld(CONTEXT_BRIDGE_KEY, mod);
