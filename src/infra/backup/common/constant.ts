/** contextBridge key */
export const CONTEXT_BRIDGE_KEY = '@infra/backup';

/** WebDAV 固定远端备份路径 */
export const WEBDAV_BACKUP_PATH = '/MusicFree/MusicFreeBackup.json';

/** 快照目录（多份留存，按策略自动清理） */
export const SNAPSHOT_DIR = '/MusicFree/backup';

/** 最新备份路径（永远覆盖，恢复默认读它） */
export const LATEST_BACKUP_PATH = '/MusicFree/backup/latest.json';

/** 快照文件前缀 */
export const SNAPSHOT_PREFIX = 'MusicFreeBackup-';

/** 快照总量上限 */
export const SNAPSHOT_MAX_KEEP = 8;

/** 生成快照文件名（UTC，避免时区/非法字符问题） */
export function buildSnapshotName(date = new Date(), suffix = ''): string {
    const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${SNAPSHOT_PREFIX}${iso}${suffix}.json`;
}

/** IPC 通道 */
export const IPC = {
    /** invoke: 备份到指定本地文件路径 */
    BACKUP_TO_FILE: '@infra/backup/backup-to-file',
    /** invoke: 从指定本地文件路径恢复 */
    RESTORE_FROM_FILE: '@infra/backup/restore-from-file',
    /** invoke: 预览备份文件内容（选择性恢复用） */
    PREVIEW_FILE: '@infra/backup/preview-file',
    /** invoke: 预览云端备份内容 */
    PREVIEW_WEBDAV: '@infra/backup/preview-webdav',
    /** invoke: 列出云端快照 */
    GET_SNAPSHOTS: '@infra/backup/get-snapshots',
    /** invoke: 备份到 WebDAV */
    BACKUP_TO_WEBDAV: '@infra/backup/backup-to-webdav',
    /** invoke: 从 WebDAV 恢复 */
    RESTORE_FROM_WEBDAV: '@infra/backup/restore-from-webdav',
    /** invoke: 测试 WebDAV 连通性 */
    TEST_WEBDAV: '@infra/backup/test-webdav',
    /** broadcast: 进度事件 */
    PROGRESS: '@infra/backup/progress',
} as const;
