/** contextBridge key */
export const CONTEXT_BRIDGE_KEY = '@infra/cloud-disk';

/**
 * 远端目录结构（与备份共用 /MusicFree 根目录）
 *
 * /MusicFree/
 *   MusicFreeBackup.json    ← 歌单备份（backup 模块）
 *   music/                  ← 音频本体（歌名 - 歌手.ext）
 *   trash/                  ← 删除的音频移到这里，不物理删除
 */
export const CLOUD_ROOT_DIR = '/MusicFree';
export const CLOUD_MUSIC_DIR = '/MusicFree/music';
export const CLOUD_TRASH_DIR = '/MusicFree/trash';
/** 歌词备份目录（.lrc） */
export const CLOUD_LYRIC_DIR = '/MusicFree/lyrics';

/** 不存在的 WebDAV 目录错误码 */
export const DAV_NOT_FOUND = 404;

/** IPC 通道 */
export const IPC = {
    /** 获取云盘音乐列表（可选 force 强制刷新） */
    GET_ITEMS: '@infra/cloud-disk/get-items',
    /** 获取连接状态（不抛错） */
    GET_STATUS: '@infra/cloud-disk/get-status',
    /** 测试连通性（不抛错） */
    TEST_CONNECTION: '@infra/cloud-disk/test-connection',
    /** 上传本地文件到云盘 */
    UPLOAD_TASKS: '@infra/cloud-disk/upload-tasks',
    /** 按歌名/歌手查找云盘上的同名音频（取源优先级用） */
    RESOLVE_SOURCE: '@infra/cloud-disk/resolve-source',
    /** 手动上传过的单曲清单（选择性恢复用） */
    GET_MANUAL_UPLOADS: '@infra/cloud-disk/get-manual-uploads',
    /** 全部上传清单（自动同步对账用） */
    GET_ALL_UPLOADS: '@infra/cloud-disk/get-all-uploads',
    /** 只删上传清单里的记录（不动云端文件） */
    DELETE_UPLOAD_RECORDS: '@infra/cloud-disk/delete-upload-records',
    /** 把远端文件移入回收目录 */
    MOVE_TO_TRASH: '@infra/cloud-disk/move-to-trash',
    /** 把「本地已删除」的远端文件移入回收目录（自动同步对账用） */
    TRASH_MISSING: '@infra/cloud-disk/trash-missing',
    /** 读取云盘歌词文本（找不到返回 null） */
    GET_LYRIC_TEXT: '@infra/cloud-disk/get-lyric-text',
    /** 上传歌词文本到云盘歌词目录 */
    PUT_LYRIC_TEXT: '@infra/cloud-disk/put-lyric-text',
    /** 列出云盘歌词目录下的歌词文件 */
    LIST_LYRIC_FILES: '@infra/cloud-disk/list-lyric-files',
    /** 把云盘文件下载到本地（按单曲恢复） */
    DOWNLOAD_TO_LOCAL: '@infra/cloud-disk/download-to-local',
    /** 广播：云盘内容变化 */
    FILES_CHANGED: '@infra/cloud-disk/files-changed',
    /** 广播：上传进度 */
    UPLOAD_PROGRESS: '@infra/cloud-disk/upload-progress',
} as const;

/** 上传并发数（坚果云对并发敏感，保持小并发） */
export const UPLOAD_CONCURRENCY = 2;

/** 远端列表缓存有效期（超过后自动重新拉取，保证在网盘侧手动改动后能及时看到） */
export const LIST_CACHE_TTL_MS = 60 * 1000;
