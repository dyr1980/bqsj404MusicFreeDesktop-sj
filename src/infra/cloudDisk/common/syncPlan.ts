/**
 * 云盘自动同步的对账决策（纯函数，零依赖，便于单测）
 *
 * 判定「远端文件该不该移入回收站」的保守规则，只有**同时满足**下面几条才算孤儿：
 *   1. 当前本地已不再管理这首歌（(platform,id) 与「作品键」都不在本地任务里）
 *   2. 清单里记录的本地路径也存在不了
 *   3. 清单里**有**本地路径（「从音源直传」的条目没有本地文件，永远不动）
 *
 * 这样处理的目的：
 *   - 本地把歌**删掉**（记录+文件都没了）→ 云端移入回收站 ✓
 *   - 本地只是**移动/改名**了歌（新位置仍在管理）→ 云端保留，并由上传步骤按新路径续上 ✓
 *   - 本地只是**换了插件/来源**播同一首歌（(platform,id) 变了）→ 作品键仍命中，云端保留 ✓
 *   - 本地文件被外部删除但记录还在 → 保守保留云端副本（不误删用户的云备份）✓
 *   - 从来没在本地存在过（从音源直传的云端备份）→ 一直保留 ✓
 */

export interface IUploadManifestRow {
    platform?: string;
    musicId?: string;
    localPath?: string;
    remotePath: string;
    /** 作品键（归一化 歌名|歌手）—— 老记录可能没有 */
    workKey?: string | null;
}

/** 与 @common/mediaKey 的 compositeKey 一致：platform + \0 + id */
export function uploadKey(platform: string, musicId: string): string {
    return `${platform}\0${String(musicId)}`;
}

/**
 * 云端文件的显示名：直接用文件名（去掉扩展名）。
 *
 * 列表展示一律用它，**不依赖本地的标题/歌手记录，也绝不回退显示歌曲 ID** ——
 * 这样即使本地记录缺失（例如歌被删了、还没同步），云端列表的名字依然正常。
 */
export function cloudDisplayName(remotePath: string): string {
    const base = String(remotePath ?? '')
        .split('/')
        .pop()
        ?.trim();
    if (!base) return '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

export function selectOrphanUploads(
    manifest: IUploadManifestRow[],
    managedKeys: Set<string>,
    existingPaths: Set<string>,
    managedWorkKeys: Set<string> = new Set(),
): string[] {
    const orphans: string[] = [];
    const seen = new Set<string>();

    for (const row of manifest ?? []) {
        if (!row?.remotePath) continue;

        // ① 这首歌当前仍由本地管理（可能换了路径）→ 不是孤儿
        if (row.platform && row.musicId && managedKeys.has(uploadKey(row.platform, row.musicId))) {
            continue;
        }
        // ①' 作品级判断：同一首歌换了插件/来源，(platform,id) 会变，
        //     但作品键不变 —— 只要本地还有这首作品，云端这份就不该进回收站
        if (row.workKey && managedWorkKeys.has(row.workKey)) {
            continue;
        }
        // ② 没有任何本地线索（含「从音源直传」这种本来就没有本地文件的条目）→ 不动它。
        //    「不下载到本地也能传云端」是用户明确要的云端备份，本地没文件是常态；
        //    「本地删了 → 云端也删」只对**当初从本地文件传上去**的条目成立。
        if (!row.localPath) continue;
        // ③ 记录的本地路径仍然存在 → 不是孤儿
        if (existingPaths.has(row.localPath)) {
            continue;
        }
        if (seen.has(row.remotePath)) continue;
        seen.add(row.remotePath);
        orphans.push(row.remotePath);
    }

    return orphans;
}
