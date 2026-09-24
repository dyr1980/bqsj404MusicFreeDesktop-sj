/**
 * cloudDisk — Renderer 层
 *
 * 职责：封装 Preload Bridge，提供类型安全的云盘 API。
 */

import { CONTEXT_BRIDGE_KEY } from './common/constant';
import type {
    ICloudDownloadOptions,
    ICloudDownloadResult,
    ICloudDownloadTask,
    ICloudLyricFile,
    ICloudStatus,
    ICloudUploadIdentity,
    ICloudUploadProgress,
    ICloudUploadRecord,
    ICloudUploadResult,
    ICloudUploadSource,
    ICloudUploadTask,
} from '@appTypes/infra/cloudDisk';

interface IMod {
    getAllItems(force?: boolean): Promise<IMusic.IMusicItem[]>;
    getStatus(): Promise<ICloudStatus>;
    testConnection(): Promise<ICloudStatus>;
    uploadTasks(
        tasks: ICloudUploadTask[],
        source?: ICloudUploadSource,
    ): Promise<ICloudUploadResult>;
    resolveSource(item: { title?: string; artist?: string }): Promise<string | null>;
    getManualUploads(): Promise<ICloudUploadRecord[]>;
    getAllUploads(): Promise<ICloudUploadRecord[]>;
    deleteUploadRecords(records: ICloudUploadIdentity[]): Promise<number>;
    moveToTrash(remotePaths: string[]): Promise<number>;
    trashMissing(managedKeys: string[], managedWorkKeys?: string[]): Promise<number>;
    downloadToLocal(
        tasks: ICloudDownloadTask[],
        options?: ICloudDownloadOptions,
    ): Promise<ICloudDownloadResult>;
    getLyricText(name: string): Promise<string | null>;
    putLyricText(name: string, text: string): Promise<boolean>;
    listLyricFiles(): Promise<ICloudLyricFile[]>;
    onFilesChanged(cb: () => void): () => void;
    onUploadProgress(cb: (progress: ICloudUploadProgress) => void): () => void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

class CloudDiskRenderer {
    /** No-op：保持 bootstrap 调用兼容 */
    async setup() {}

    /** 云盘音乐列表（force = true 强制刷新） */
    public getAllItems(force = false): Promise<IMusic.IMusicItem[]> {
        return mod.getAllItems(force);
    }

    /** 连接状态 */
    public getStatus(): Promise<ICloudStatus> {
        return mod.getStatus();
    }

    /** 测试 WebDAV 连通性 */
    public testConnection(): Promise<ICloudStatus> {
        return mod.testConnection();
    }

    /** 上传本地文件到云盘（增量：远端同名同大小则跳过） */
    public uploadTasks(
        tasks: ICloudUploadTask[],
        source: ICloudUploadSource = 'manual',
    ): Promise<ICloudUploadResult> {
        return mod.uploadTasks(tasks, source);
    }

    /**
     * 按歌名/歌手查找云盘上的同名音频，返回可播放地址（找不到返回 null）。
     * 用于取源优先级：本地 → 云盘 → 插件。
     */
    public resolveStreamUrl(item: { title?: string; artist?: string }): Promise<string | null> {
        return mod.resolveSource(item);
    }

    /** 手动上传过的单曲清单（选择性恢复用） */
    public getManualUploads(): Promise<ICloudUploadRecord[]> {
        return mod.getManualUploads();
    }

    /** 全部上传清单（自动同步对账用） */
    public getAllUploads(): Promise<ICloudUploadRecord[]> {
        return mod.getAllUploads();
    }

    /**
     * 只删上传清单里的记录（保留云端文件）。
     *
     * 与 `moveToTrash` 的区别：那个会连云端文件一起移入回收站；
     * 这个只是把「已传云端」这条记账从清单里去掉。
     */
    public deleteUploadRecords(records: ICloudUploadIdentity[]): Promise<number> {
        return mod.deleteUploadRecords(records);
    }

    /** 把远端文件移入 /MusicFree/trash（不物理删除） */
    public moveToTrash(remotePaths: string[]): Promise<number> {
        return mod.moveToTrash(remotePaths);
    }

    /**
     * 把「本地已彻底删除」的歌对应的远端文件移入回收站。
     * 判定在主进程完成（保守规则，避免移动/改名/换插件被误判为删除）。
     *
     * @param managedKeys 本地仍在管理的 (platform,id) 键
     * @param managedWorkKeys 本地仍在管理的作品键（归一化 歌名|歌手）
     */
    public trashMissingLocalFiles(
        managedKeys: string[],
        managedWorkKeys: string[] = [],
    ): Promise<number> {
        return mod.trashMissing(managedKeys, managedWorkKeys);
    }

    /**
     * 把云盘文件下载到本地（按单曲恢复用）。
     * 下载后会写入下载记录，播放时「本地优先」即可命中。
     */
    /** 读取云盘歌词文本（找不到返回 null） */
    public getLyricText(name: string): Promise<string | null> {
        return mod.getLyricText(name);
    }

    /** 上传歌词文本到云盘歌词目录 */
    public putLyricText(name: string, text: string): Promise<boolean> {
        return mod.putLyricText(name, text);
    }

    /**
     * 列出云盘歌词目录（/MusicFree/lyrics）下的歌词文件。
     * 歌词搜索弹窗的「云盘」来源、以及恢复歌词时用。
     */
    public listLyricFiles(): Promise<ICloudLyricFile[]> {
        return mod.listLyricFiles();
    }

    public downloadToLocal(
        tasks: ICloudDownloadTask[],
        options?: ICloudDownloadOptions,
    ): Promise<ICloudDownloadResult> {
        return mod.downloadToLocal(tasks, options);
    }

    /** 云盘内容变化广播 */
    public onFilesChanged(cb: () => void): () => void {
        return mod.onFilesChanged(cb);
    }

    /** 上传进度广播 */
    public onUploadProgress(cb: (progress: ICloudUploadProgress) => void): () => void {
        return mod.onUploadProgress(cb);
    }
}

const cloudDisk = new CloudDiskRenderer();
export default cloudDisk;
