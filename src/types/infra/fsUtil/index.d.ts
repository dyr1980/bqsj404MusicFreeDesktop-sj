/**
 * fsUtil 暴露给 renderer 的文件系统 API 接口契约
 */
export interface IFsUtilMod {
    /**
     * 写文件。
     *
     * `data` 允许 Uint8Array：渲染进程沙箱化后没有 Node 的 Buffer，
     * 二进制内容只能以 Uint8Array 穿过 contextBridge，由 preload 侧归一化。
     */
    writeFile(
        path: string,
        data: string | Buffer | Uint8Array,
        options?: { encoding?: BufferEncoding; flag?: string },
    ): Promise<void>;

    readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;

    isFile(path: string): Promise<boolean>;

    isFolder(path: string): Promise<boolean>;

    rimraf(path: string): Promise<void>;

    /** 文件大小（字节）；路径不存在或不是文件时返回 null */
    getFileSize(path: string): Promise<number | null>;

    addFileScheme(filePath: string): string;

    fileUrlToPath(fileUrl: string): string;

    getPathForFile(file: File): string;

    normalizePath(filePath: string): string;

    pathSep: string;
}
