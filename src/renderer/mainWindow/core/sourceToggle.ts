/**
 * sourceToggle — 换源应用层
 *
 * 负责把「已匹配到的换源结果」落到具体的持久化列表上：
 *   - 本地歌单（含收藏夹）：替换歌曲并保持原有位置
 *   - 播放队列：替换队列中的歌曲，若替换的是当前播放歌曲则重新加载播放
 *   - 最近播放：替换记录中的歌曲
 *
 * 与 sourceMatch 的分工：
 *   sourceMatch  只负责「找出匹配的歌曲」（纯逻辑）
 *   sourceToggle 负责「把结果写回列表」（有副作用）
 */

import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { compositeKey } from '@common/mediaKey';
import musicItemToSlim from '@common/musicItemToSlim';
import musicSheet from '@infra/musicSheet/renderer';
import { PLAY_QUEUE_SHEET_ID } from '@infra/musicSheet/common/constant';
import trackPlayer from './trackPlayer';
import { RECENTLY_PLAYED_ID, replaceInRecentlyPlayed } from './recentlyPlayed';

// ─── 类型 ───

/** 一组换源结果：old 是被替换的歌曲，new 是匹配到的新歌曲 */
export interface ITogglePair {
    old: IMedia.IMediaBase;
    new: IMusic.IMusicItem;
}

/** 换源应用结果 */
export interface IToggleApplyResult {
    /** 实际完成换源的歌曲数 */
    applied: number;
    /** 因目标歌曲已存在等原因跳过的数量 */
    skipped: number;
}

/** 歌单换源执行计划 */
interface ITogglePlan {
    /** 需要移除的歌曲（按 key 去重） */
    removeBases: IMedia.IMediaBase[];
    /** 需要新增的歌曲（按 key 去重） */
    addItems: IMusic.IMusicItem[];
    /** 期望的最终顺序 */
    desiredList: IMusicItemSlim[];
    /** 跳过的数量（目标已在列表中存在） */
    skipped: number;
}

// ─── 计划构造 ───

/**
 * 根据当前列表与换源结果，计算所需的增删与最终顺序。
 *
 * 规则：
 *   - 目标歌曲已存在于列表（或已被本次其他换源结果占用）时跳过，避免产生重复歌曲
 *   - 同一旧 key 的多条记录最终只保留一条（移除按 key 全清后再补一条）
 */
function buildTogglePlan(orderedList: IMusicItemSlim[], pairs: ITogglePair[]): ITogglePlan {
    const replacementMap = new Map<string, IMusic.IMusicItem>();
    for (const pair of pairs) {
        const key = compositeKey(pair.old.platform, String(pair.old.id));
        if (!replacementMap.has(key)) replacementMap.set(key, pair.new);
    }

    const existingKeys = new Set(orderedList.map((it) => compositeKey(it.platform, it.id)));
    const removeMap = new Map<string, IMedia.IMediaBase>();
    const addMap = new Map<string, IMusic.IMusicItem>();
    const claimedKeys = new Set<string>();
    const desiredList: IMusicItemSlim[] = [];
    const desiredKeys = new Set<string>();
    let skipped = 0;

    for (const item of orderedList) {
        const key = compositeKey(item.platform, item.id);
        const replacement = replacementMap.get(key);

        if (!replacement) {
            if (!desiredKeys.has(key)) {
                desiredKeys.add(key);
                desiredList.push(item);
            }
            continue;
        }

        const targetKey = compositeKey(replacement.platform, String(replacement.id));

        // 目标歌曲已存在于列表，或已被本次换源占用 → 跳过，避免重复
        if (existingKeys.has(targetKey) || claimedKeys.has(targetKey)) {
            skipped++;
            // 若该旧 key 已被本次换源移除（同一首歌在列表中重复出现），
            // 则不再把它塞回期望列表，否则会与移除操作产生不一致
            if (!removeMap.has(key) && !desiredKeys.has(key)) {
                desiredKeys.add(key);
                desiredList.push(item);
            }
            continue;
        }

        claimedKeys.add(targetKey);
        removeMap.set(key, { platform: item.platform, id: String(item.id) });
        addMap.set(targetKey, replacement);
        if (!desiredKeys.has(targetKey)) {
            desiredKeys.add(targetKey);
            desiredList.push(musicItemToSlim(replacement));
        }
    }

    return {
        removeBases: [...removeMap.values()],
        addItems: [...addMap.values()],
        desiredList,
        skipped,
    };
}

// ─── 各列表的换源实现 ───

/**
 * 在本地歌单内批量换源（保持歌曲原有位置）。
 *
 * 通过 remove → add → updateOrder 三步完成，三步共用 musicSheet 的
 * MutationQueue，因此 IPC 顺序有保证；updateMusicOrder 会把 UI 的乐观状态
 * 直接置为期望顺序。
 *
 * @param sheetId     目标歌单 ID
 * @param orderedList 该歌单当前完整歌曲列表（顺序即最终展示顺序）
 * @param pairs       换源结果
 */
export function toggleInSheetList(
    sheetId: string,
    orderedList: IMusicItemSlim[],
    pairs: ITogglePair[],
): IToggleApplyResult {
    if (!pairs.length || !orderedList.length) {
        return { applied: 0, skipped: pairs.length };
    }

    const plan = buildTogglePlan(orderedList, pairs);
    if (!plan.addItems.length) {
        return { applied: 0, skipped: plan.skipped };
    }

    musicSheet.removeMusicFromSheet(plan.removeBases, sheetId);
    musicSheet.addMusicToSheet(plan.addItems, sheetId);
    musicSheet.updateMusicOrder(sheetId, plan.desiredList);

    return { applied: plan.addItems.length, skipped: plan.skipped };
}

/**
 * 读取歌单完整歌曲列表并执行换源。
 * 用于「歌单名称右键批量换源」等当前歌单未打开的场景。
 */
export async function toggleInSheetById(
    sheetId: string,
    pairs: ITogglePair[],
): Promise<IToggleApplyResult> {
    const list = await musicSheet.getSheetMusicList(sheetId);
    return toggleInSheetList(sheetId, list, pairs);
}

/**
 * 统一入口：按 sheetId 决定换源落到哪个列表。
 *
 * @param sheetId 上下文歌单 ID：
 *   - 播放队列虚拟 ID      → 仅替换播放队列
 *   - 最近播放虚拟 ID      → 仅替换最近播放记录
 *   - 其它（本地歌单 ID）  → 替换歌单内容，并同步播放队列中的同名歌曲
 */
export async function applyToggle(
    sheetId: string,
    pairs: ITogglePair[],
): Promise<IToggleApplyResult> {
    if (!pairs.length) return { applied: 0, skipped: 0 };

    if (sheetId === PLAY_QUEUE_SHEET_ID) {
        const applied = await trackPlayer.replaceMusicInQueue(pairs);
        return { applied, skipped: pairs.length - applied };
    }

    if (sheetId === RECENTLY_PLAYED_ID) {
        const applied = await replaceInRecentlyPlayed(pairs);
        return { applied, skipped: pairs.length - applied };
    }

    const result = await toggleInSheetById(sheetId, pairs);
    // 播放队列是歌单的快照副本，同步替换其中的同名歌曲，避免换源后仍在播放旧来源
    await trackPlayer.replaceMusicInQueue(pairs);
    return result;
}
