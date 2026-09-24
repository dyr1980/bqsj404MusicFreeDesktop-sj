/**
 * cloudDisk — Preload 层
 *
 * 职责: 纯桥接，无状态。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, CONTEXT_BRIDGE_KEY } from './common/constant';

const mod = {
    getAllItems: (force?: boolean) => ipcRenderer.invoke(IPC.GET_ITEMS, force),
    getStatus: () => ipcRenderer.invoke(IPC.GET_STATUS),
    testConnection: () => ipcRenderer.invoke(IPC.TEST_CONNECTION),
    uploadTasks: (tasks: unknown, source?: string) =>
        ipcRenderer.invoke(IPC.UPLOAD_TASKS, tasks, source),
    resolveSource: (item: { title?: string; artist?: string }) =>
        ipcRenderer.invoke(IPC.RESOLVE_SOURCE, item),
    getManualUploads: () => ipcRenderer.invoke(IPC.GET_MANUAL_UPLOADS),
    getAllUploads: () => ipcRenderer.invoke(IPC.GET_ALL_UPLOADS),
    deleteUploadRecords: (records: unknown) =>
        ipcRenderer.invoke(IPC.DELETE_UPLOAD_RECORDS, records),
    moveToTrash: (remotePaths: string[]) => ipcRenderer.invoke(IPC.MOVE_TO_TRASH, remotePaths),
    trashMissing: (managedKeys: string[], managedWorkKeys?: string[]) =>
        ipcRenderer.invoke(IPC.TRASH_MISSING, managedKeys, managedWorkKeys),
    downloadToLocal: (tasks: unknown, options?: unknown) =>
        ipcRenderer.invoke(IPC.DOWNLOAD_TO_LOCAL, tasks, options),
    getLyricText: (name: string) => ipcRenderer.invoke(IPC.GET_LYRIC_TEXT, name),
    putLyricText: (name: string, text: string) =>
        ipcRenderer.invoke(IPC.PUT_LYRIC_TEXT, name, text),
    listLyricFiles: () => ipcRenderer.invoke(IPC.LIST_LYRIC_FILES),

    onFilesChanged: (cb: () => void): (() => void) => {
        const handler = () => cb();
        ipcRenderer.on(IPC.FILES_CHANGED, handler);
        return () => {
            ipcRenderer.removeListener(IPC.FILES_CHANGED, handler);
        };
    },

    onUploadProgress: (cb: (progress: unknown) => void): (() => void) => {
        const handler = (_evt: Electron.IpcRendererEvent, progress: unknown) => cb(progress);
        ipcRenderer.on(IPC.UPLOAD_PROGRESS, handler);
        return () => {
            ipcRenderer.removeListener(IPC.UPLOAD_PROGRESS, handler);
        };
    },
};

contextBridge.exposeInMainWorld(CONTEXT_BRIDGE_KEY, mod);
