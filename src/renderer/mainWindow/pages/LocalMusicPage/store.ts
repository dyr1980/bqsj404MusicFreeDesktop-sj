/**
 * LocalMusicPage Store — 本地音乐页面的派生状态
 *
 * 源数据（全量本地音乐、加载/扫描状态）在 `core/localLibrary`：
 * 那是应用级的常驻内存数据 + 主进程推送刷新，歌词管理等组件共用同一份。
 * 这里只保留页面自己的东西：最短时长过滤、以及歌手 / 专辑 / 文件夹聚合。
 */

import { atom, getDefaultStore } from 'jotai';
import appConfig from '@infra/appConfig/renderer';
import {
    allLocalMusicAtom,
    ensureLocalMusicStore as ensureLocalLibrary,
    type LocalMusicItem,
} from '@renderer/mainWindow/core/localLibrary';

// 源数据仍然从页面 store 这个入口对外可见（页面各处都是这么 import 的）
export {
    allLocalMusicAtom,
    localMusicLoadingAtom,
    scanningAtom,
} from '@renderer/mainWindow/core/localLibrary';
export type { LocalMusicItem } from '@renderer/mainWindow/core/localLibrary';

const store = getDefaultStore();

export interface ArtistAggregation {
    artist: string;
    count: number;
}

export interface AlbumAggregation {
    album: string;
    artist: string;
    count: number;
}

export interface FolderAggregation {
    folder: string;
    count: number;
}

/** 最短时长过滤阈值（秒），0 = 不过滤 */
export const minDurationSecAtom = atom(0);

/** 过滤后的本地音乐（按 minDurationSec 过滤短音频） */
export const filteredLocalMusicAtom = atom<LocalMusicItem[]>((get) => {
    const songs = get(allLocalMusicAtom);
    const minDuration = get(minDurationSecAtom);
    if (minDuration <= 0) return songs;
    return songs.filter((s) => s.duration == null || s.duration >= minDuration);
});

/** 歌手聚合列表 */
export const artistListAtom = atom<ArtistAggregation[]>((get) => {
    const songs = get(filteredLocalMusicAtom);
    const map = new Map<string, number>();
    for (const s of songs) {
        map.set(s.artist, (map.get(s.artist) ?? 0) + 1);
    }
    return Array.from(map, ([artist, count]) => ({ artist, count })).sort((a, b) =>
        a.artist.localeCompare(b.artist),
    );
});

/** 专辑聚合列表 */
export const albumListAtom = atom<AlbumAggregation[]>((get) => {
    const songs = get(filteredLocalMusicAtom);
    const map = new Map<string, AlbumAggregation>();
    for (const s of songs) {
        const key = `${s.album ?? ''}||${s.artist}`;
        const existing = map.get(key);
        if (existing) {
            existing.count++;
        } else {
            map.set(key, { album: s.album ?? '', artist: s.artist, count: 1 });
        }
    }
    return Array.from(map.values()).sort((a, b) => a.album.localeCompare(b.album));
});

/** 文件夹聚合列表 */
export const folderListAtom = atom<FolderAggregation[]>((get) => {
    const songs = get(filteredLocalMusicAtom);
    const map = new Map<string, number>();
    for (const s of songs) {
        map.set(s.folder, (map.get(s.folder) ?? 0) + 1);
    }
    return Array.from(map, ([folder, count]) => ({ folder, count })).sort((a, b) =>
        a.folder.localeCompare(b.folder),
    );
});

/** 总歌曲数 */
export const totalCountAtom = atom((get) => get(filteredLocalMusicAtom).length);

// ─── 初始化 ───

let minDurationBound = false;

/**
 * 确保本地音乐数据已加载，并绑定「最短时长」配置。
 *
 * 数据加载部分幂等且全局共用（见 core/localLibrary）；这里额外做页面专属的
 * 配置初始化与监听。多次调用安全。
 */
export function ensureLocalMusicStore(): void {
    ensureLocalLibrary();

    if (minDurationBound) return;
    minDurationBound = true;

    store.set(minDurationSecAtom, appConfig.getConfigByKey('localMusic.minDurationSec') ?? 0);

    appConfig.onConfigUpdated((patch) => {
        if ('localMusic.minDurationSec' in patch) {
            store.set(minDurationSecAtom, patch['localMusic.minDurationSec'] ?? 0);
        }
    });
}
