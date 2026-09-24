/**
 * 云盘备份快照的保留策略（纯函数，便于单测）
 *
 * 需求（用户指定）：
 * - 快照文件多份留存，总量上限 8 份
 * - 按时间递减密度：1 天内的留 1 份、1 周内的留 1 份/天、1 个月内的留 1 份/周、
 *   1 年内的留 1 份/月、更早的留 1 份
 * - 超量时从中间层（较老的）开始淘汰，**始终保留最新 1 份与最老 1 份**（历史锚点）
 */

export interface ISnapshotFile {
    /** 文件名（含扩展名） */
    name: string;
    /** 修改时间（ms 时间戳） */
    mtime: number;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 时间桶：同一桶内只保留最新那一份 */
function bucketOf(ageMs: number): string {
    if (ageMs <= DAY) return 'recent';
    if (ageMs <= 7 * DAY) {
        // 1 周内：按天分桶
        return `d${Math.floor(ageMs / DAY)}`;
    }
    if (ageMs <= 30 * DAY) {
        // 1 月内：按周分桶
        return `w${Math.floor(ageMs / (7 * DAY))}`;
    }
    if (ageMs <= 365 * DAY) {
        // 1 年内：按月分桶（约 30 天）
        return `m${Math.floor(ageMs / (30 * DAY))}`;
    }
    // 更早：按年分桶
    return `y${Math.floor(ageMs / (365 * DAY))}`;
}

/**
 * 计算需要保留的快照文件名。
 *
 * @param files 云端已存在的快照文件
 * @param now 当前时间（ms）
 * @param maxKeep 总量上限（默认 8）
 * @returns 需要保留的文件名集合
 */
export function selectSnapshotsToKeep(
    files: ISnapshotFile[],
    now: number,
    maxKeep = 8,
): string[] {
    if (!files.length) return [];

    // 1) 按时间倒序
    const sorted = [...files].sort((a, b) => b.mtime - a.mtime);

    // 2) 每个时间桶保留最新的一份
    const seenBuckets = new Set<string>();
    const kept: ISnapshotFile[] = [];
    for (const file of sorted) {
        const bucket = bucketOf(Math.max(0, now - file.mtime));
        if (seenBuckets.has(bucket)) continue;
        seenBuckets.add(bucket);
        kept.push(file);
    }

    // 3) 超量：从「中间层」淘汰（保留最新 1 份和最老 1 份）
    if (kept.length > maxKeep) {
        const newest = kept[0];
        const oldest = kept[kept.length - 1];
        const middle = kept.slice(1, -1);
        // 中间层按时间倒序，优先淘汰较老的（靠后的）
        const keepMiddleCount = Math.max(0, maxKeep - 2);
        const keptMiddle = middle.slice(0, keepMiddleCount);
        return [newest, ...keptMiddle, oldest].map((f) => f.name);
    }

    return kept.map((f) => f.name);
}

/** 计算需要删除的快照文件名 */
export function selectSnapshotsToDelete(
    files: ISnapshotFile[],
    now: number,
    maxKeep = 8,
): string[] {
    const keep = new Set(selectSnapshotsToKeep(files, now, maxKeep));
    return files.filter((f) => !keep.has(f.name)).map((f) => f.name);
}
