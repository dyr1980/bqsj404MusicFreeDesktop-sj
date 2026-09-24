/**
 * sourceSwitch — 「把歌换成 本地文件 / 云端 来源」的共用逻辑
 *
 * 三处入口共用同一套匹配规则（本地优先 → 云端同名 → 交给自动换源）：
 *   - 单曲换源弹窗（ToggleSourceModal 里的本地/云端两条）
 *   - 批量换源弹窗（ToggleSourceMoreModal，选中一批后统一换）
 *   - 播放队列的整队切换（trackPlayer.switchQueueSource）
 *
 * 规则细节：
 *   - 原始身份（换之前的 platform/id）记进 `originPlatform` / `originId`，
 *     下载记录、手动关联歌词、「还原来源」都靠它反查
 *   - 云端条目命中时 **id 换成云盘上的远端路径**（云盘插件按 id 取流），
 *     否则换过去也放不出来，只能再走一次自动换源
 *   - 没命中的也照换（标 `sourceMatched: false`，列表里变暗提示），
 *     播放时交给自动换源去找，行为和之前一致
 */

import { CLOUD_PLUGIN_NAME, LOCAL_PLUGIN_NAME } from '@common/constant';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import cloudSource from '@renderer/mainWindow/core/cloudSource';
import localSource from '@renderer/mainWindow/core/localSource';

/** 切换目标：本地文件 / 云端 */
export type TSourceSwitchKind = 'local' | 'cloud';

export interface ISourceSwitchResult {
    /** 与输入**同序**的替换结果 */
    items: IMusicItemSlim[];
    /** 命中数（本地有文件 / 云端有同名） */
    matched: number;
}

/**
 * 把一批歌曲换成「本地文件 / 云端」来源。
 *
 * @param items 待处理的歌曲（按原顺序返回）
 * @param kind  目标来源
 */
export async function switchItemsToSource(
    items: ReadonlyArray<IMusicItemSlim>,
    kind: TSourceSwitchKind,
): Promise<ISourceSwitchResult> {
    const label = kind === 'local' ? LOCAL_PLUGIN_NAME : CLOUD_PLUGIN_NAME;

    // 云端状态已经在 cloudSource 里按作品键建好索引（真实远端列表，60s 缓存），
    // 这里逐首查内存索引，不再自己拉一遍列表。
    let matched = 0;
    const next = items.map((item) => {
        const originPlatform = item.originPlatform ?? item.platform;
        const originId = item.originId ?? String(item.id);

        if (kind === 'local') {
            // 同样按「主键 → 原始身份 → 作品键 → 歌名+歌手」找：本地真的有文件才算命中
            const hit = localSource.has({
                platform: originPlatform,
                id: originId,
                title: item.title,
                artist: item.artist,
            });
            if (hit) matched++;
            return {
                ...item,
                platform: label,
                originPlatform,
                originId,
                sourceMatched: hit,
            } as IMusicItemSlim;
        }

        const match = cloudSource.getRemoteItem({
            platform: originPlatform,
            id: originId,
            title: item.title,
            artist: item.artist,
        });
        if (match) matched++;
        return {
            ...item,
            platform: label,
            // 命中的话把 id 换成远端路径，云盘插件才能取到流
            id: match ? String(match.id) : String(item.id),
            duration: match?.duration ?? item.duration,
            originPlatform,
            originId,
            sourceMatched: !!match,
        } as IMusicItemSlim;
    });

    return { items: next, matched };
}
