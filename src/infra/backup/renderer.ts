/**
 * backup — 渲染进程层
 *
 * 无状态，仅封装 preload 暴露的 API 为类型安全的函数。
 */
import type {
    RestoreMode,
    IBackupPreview,
    IBackupResult,
    IBackupProgress,
    IBackupSelection,
} from '@appTypes/infra/backup';
import { CONTEXT_BRIDGE_KEY } from './common/constant';

interface IMod {
    backupToFile(filePath: string): Promise<IBackupResult>;
    restoreFromFile(
        filePath: string,
        mode: RestoreMode,
        selection?: IBackupSelection,
    ): Promise<IBackupResult>;
    previewFile(filePath: string): Promise<IBackupPreview>;
    previewWebDAV(): Promise<IBackupPreview>;
    getSnapshots(): Promise<Array<{ name: string; mtime: number }>>;
    backupToWebDAV(): Promise<IBackupResult>;
    restoreFromWebDAV(mode: RestoreMode, selection?: IBackupSelection): Promise<IBackupResult>;
    testWebDAV(): Promise<IBackupResult>;
    onProgress(cb: (progress: IBackupProgress) => void): () => void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

const backup = {
    backupToFile: mod.backupToFile.bind(mod),
    restoreFromFile: mod.restoreFromFile.bind(mod),
    previewFile: mod.previewFile.bind(mod),
    previewWebDAV: mod.previewWebDAV.bind(mod),
    getSnapshots: mod.getSnapshots.bind(mod),
    backupToWebDAV: mod.backupToWebDAV.bind(mod),
    restoreFromWebDAV: mod.restoreFromWebDAV.bind(mod),
    testWebDAV: mod.testWebDAV.bind(mod),
    onProgress: mod.onProgress.bind(mod),
};

export default backup;
