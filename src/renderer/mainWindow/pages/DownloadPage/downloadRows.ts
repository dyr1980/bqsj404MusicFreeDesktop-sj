/**
 * downloadRows — 下载管理列表的行模型
 *
 * 下载管理现在是一个**列表**（不再分「下载队列 / 已完成」两个 Tab），
 * 里面混三种来源：
 *   - task       正在/等待/暂停/失败的下载任务
 *   - downloaded 已下载到本地的文件（`__downloaded__` 歌单 + 下载记录）
 *   - upload     云端上传记录（`cloud_uploads` 清单）
 *
 * 行模型把三者统一成同一张表的形状，页面只负责渲染与筛选。
 *
 * 三种记录在数据库里各有一张表、字段也不一样，这里做两件「拉平」的事：
 *   1. `item`：三种行都给出一条可播放的歌曲条目 —— 右键菜单因此完全一致
 *      （以前只有「已下载」行有 item，云端行右键出来只有两三个下载项）
 *   2. `time` + 默认倒序：三种记录各有自己的时间字段，统一成 `time` 后按它排，
 *      「最新的在最上面」对三种记录是同一套规则
 */

import { compositeKey } from '@common/mediaKey';
import type { IDownloadTask } from '@appTypes/infra/downloadManager';
import type { ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

/** 行状态（筛选也按它） */
export type TDownloadRowStatus =
    | 'pending'
    | 'downloading'
    | 'paused'
    | 'error'
    | 'done'
    | 'uploaded';

/** 行来源 */
export type TDownloadRowKind = 'task' | 'downloaded' | 'upload';

/** 排序方向 */
export type TDownloadSortOrder = 'desc' | 'asc';

export interface IDownloadRow {
    /** 唯一 key（多选按它） */
    key: string;
    kind: TDownloadRowKind;
    status: TDownloadRowStatus;
    /** 歌曲身份（云端清单记录的定位、批量操作都用它） */
    platform: string;
    musicId: string;
    title: string;
    artist: string;
    album: string;
    size?: number;
    /** 本地文件路径 */
    path?: string;
    /** 云端路径 */
    remotePath?: string;
    uploadSource?: ICloudUploadRecord['source'];
    /**
     * 这条记录的产生时间（ms，三种来源各自的语义）：
     *   - task       → 任务创建时间
     *   - downloaded → 写入下载记录的时间（老记录退回 mediaMeta 更新时间）
     *   - upload     → 上传清单的写入时间
     * 列表默认按它倒序（最新的在最上面）。取不到时为 0（排最后）。
     */
    time: number;
    /** 原始下载任务（操作列要用） */
    task?: IDownloadTask;
    /**
     * 「已下载」行对应的本地文件已经不存在了（外部删除 / 盘没挂上）。
     *
     * 由页面按文件系统校验后回填，**只用来收掉「在文件夹中显示」**（点了也是空的）。
     * 状态列不因此改文案：那列说的是这条记录当时的状态（下成功过），
     * 「文件现在在不在」由左边的本地图标回答。
     */
    missing?: boolean;
    /**
     * 歌曲条目：三种行都有。
     *
     * 既给「双击播放 / 右键菜单」用，也给状态列（收藏 / 下载 / 云端三个图标）用 ——
     * 之前云端行只有一份 `stateItem`，右键菜单因此被降级成「只有下载管理专用项」。
     */
    item: IMusic.IMusicItem | IMusicItemSlim;
}

export interface IBuildDownloadRowsInput {
    tasks: readonly IDownloadTask[];
    /** 下载记录：platform / musicId / path */
    downloaded: ReadonlyArray<{
        platform: string;
        musicId: string;
        path: string;
        title?: string;
        artist?: string;
        downloadedAt?: number;
    }>;
    /** `__downloaded__` 歌单里的条目（补标题/歌手/专辑；三种行共用） */
    downloadedItems?: readonly IMusicItemSlim[];
    /** 云端上传清单 */
    uploads?: readonly ICloudUploadRecord[];
}

/** 组装一条精简歌曲条目（只填展示/图标判定需要的字段） */
function buildSlimItem(source: {
    platform: string;
    id: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number | null;
    artwork?: string | null;
}): IMusicItemSlim {
    return {
        platform: source.platform,
        id: source.id,
        title: source.title ?? '',
        artist: source.artist ?? '',
        album: source.album ?? '',
        duration: source.duration ?? null,
        artwork: source.artwork ?? null,
    };
}

/**
 * 组装三种来源的行，并按时间倒序（最新在前）。
 *
 * 歌曲条目优先用 `__downloaded__` 歌单里的完整数据（标题/专辑/封面更全），
 * 取不到再退回「记录里的字段拼一条精简条目」。
 */
export function buildDownloadRows({
    tasks,
    downloaded,
    downloadedItems = [],
    uploads = [],
}: IBuildDownloadRowsInput): IDownloadRow[] {
    const knownItems = new Map<string, IMusicItemSlim>();
    for (const item of downloadedItems) {
        knownItems.set(compositeKey(item.platform, item.id), item);
    }
    const itemOf = (platform: string, id: string, fallback: () => IMusicItemSlim) =>
        knownItems.get(compositeKey(platform, id)) ?? fallback();

    const rows: IDownloadRow[] = [];

    for (const task of tasks) {
        const musicId = String(task.musicId);
        rows.push({
            key: `task:${task.id}`,
            kind: 'task',
            status: task.status as TDownloadRowStatus,
            platform: task.platform,
            musicId,
            title: task.title ?? '',
            artist: task.artist ?? '',
            album: task.album ?? '',
            size: task.totalBytes > 0 ? task.totalBytes : undefined,
            time: task.createdAt,
            task,
            item: itemOf(task.platform, musicId, () =>
                buildSlimItem({
                    platform: task.platform,
                    id: musicId,
                    title: task.title,
                    artist: task.artist,
                    album: task.album,
                }),
            ),
        });
    }

    for (const record of downloaded) {
        const item = itemOf(record.platform, record.musicId, () =>
            buildSlimItem({
                platform: record.platform,
                id: record.musicId,
                title: record.title,
                artist: record.artist,
            }),
        );
        rows.push({
            key: `local:${compositeKey(record.platform, record.musicId)}`,
            kind: 'downloaded',
            status: 'done',
            platform: record.platform,
            musicId: record.musicId,
            title: item.title || record.title || record.path.split(/[\\/]/).pop() || '',
            artist: item.artist || record.artist || '',
            album: item.album ?? '',
            path: record.path,
            // 老记录没有下载时间 → 0，排到最后（筛选/搜索都还在）
            time: record.downloadedAt ?? 0,
            item,
        });
    }

    for (const record of uploads) {
        const musicId = String(record.musicId);
        const item = itemOf(record.platform, musicId, () =>
            buildSlimItem({
                platform: record.platform,
                id: musicId,
                title: record.title,
                artist: record.artist,
            }),
        );
        rows.push({
            key: `cloud:${compositeKey(record.platform, musicId)}:${record.remotePath}`,
            kind: 'upload',
            status: 'uploaded',
            platform: record.platform,
            musicId,
            title: item.title || record.title || record.remotePath.split('/').pop() || '',
            artist: item.artist || record.artist || '',
            album: item.album ?? '',
            size: record.size,
            path: record.localPath,
            remotePath: record.remotePath,
            uploadSource: record.source,
            time: record.uploadedAt ?? 0,
            item,
        });
    }

    return sortDownloadRows(rows, 'desc');
}

/**
 * 按记录时间排序（默认最新在前）。
 *
 * 时间相同的行保持原有相对顺序（Array#sort 稳定）：任务行是「创建时间倒序」进来的，
 * 老记录（time = 0）则维持数据库给它们的顺序。
 */
export function sortDownloadRows(
    rows: readonly IDownloadRow[],
    order: TDownloadSortOrder,
): IDownloadRow[] {
    const direction = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => (a.time - b.time) * direction);
}

/** 状态筛选项 */
export type TDownloadStatusFilter = 'all' | TDownloadRowStatus;

/** 行是否命中某个状态筛选 */
export function matchesStatusFilter(row: IDownloadRow, filter: TDownloadStatusFilter): boolean {
    if (filter === 'all') return true;
    return row.status === filter;
}

/** 搜索（标题 / 歌手 / 专辑 / 文件名 / 云端路径） */
export function matchesSearch(row: IDownloadRow, keyword: string): boolean {
    if (!keyword) return true;
    const haystack = [row.title, row.artist, row.album, row.path, row.remotePath]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
    return haystack.includes(keyword);
}
