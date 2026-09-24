/**
 * localLibrary — 本地音乐库的**常驻内存**状态
 *
 * 数据源：`localMusic.getAllMusicItems()`（一次全量 IPC）。
 * 首次使用时拉全量，之后靠主进程 `onLibraryChanged` 推送刷新（防抖 200ms），
 * 所以重复进入页面 / 弹窗都是秒开，不会反复发请求。
 *
 * 放在 core 而不是 LocalMusicPage 里，是因为「歌词管理」这类组件也要用同一份
 * 数据（不然它自己拉一遍，既慢又和页面不同步）。页面侧的派生状态（最短时长
 * 过滤、歌手/专辑/文件夹聚合）留在 `pages/LocalMusicPage/store.ts`。
 */

import { atom, getDefaultStore } from 'jotai';
import localMusic from '@infra/localMusic/renderer';
import debounce from '@common/debounce';

const store = getDefaultStore();

/** IMusicItem + folder（由主进程 toMusicItem 附加） */
export type LocalMusicItem = IMusic.IMusicItem & { folder: string };

// ─── 源数据 Atom ───

/**
 * 全量本地音乐（**不做 minDuration 过滤**）。
 *
 * 页面列表用 `filteredLocalMusicAtom`；歌词管理这类要「全集」的地方必须用这个，
 * 否则被设置里「最短时长」过滤掉的短音频会在那边凭空消失。
 */
export const allLocalMusicAtom = atom<LocalMusicItem[]>([]);

/** 是否正在加载（仅首次） */
export const localMusicLoadingAtom = atom(true);

/** 是否正在扫描本地音乐 */
export const scanningAtom = atom(false);

// ─── 初始化 ───

let initialized = false;
let loadGeneration = 0;
let firstLoad: Promise<void> | null = null;

async function loadAllMusicItems(): Promise<void> {
    const gen = ++loadGeneration;
    try {
        const items = (await localMusic.getAllMusicItems()) as LocalMusicItem[];
        if (gen !== loadGeneration) return;
        store.set(allLocalMusicAtom, items);
    } catch (e) {
        if (gen !== loadGeneration) return;
        console.error('[localLibrary] load all music items error:', e);
    } finally {
        if (gen === loadGeneration) {
            store.set(localMusicLoadingAtom, false);
        }
    }
}

const debouncedLoad = debounce(loadAllMusicItems, 200);

/**
 * 确保本地音乐数据已加载。
 * 首次调用时异步拉取全量并注册 libraryChanged 监听。
 * 多次调用安全（幂等）。注册的监听为永久性全局监听，无需清理。
 */
export function ensureLocalMusicStore(): void {
    if (initialized) return;
    initialized = true;

    firstLoad = loadAllMusicItems();

    localMusic.onLibraryChanged(() => {
        debouncedLoad();
    });

    localMusic.onScanProgress((p) => {
        store.set(scanningAtom, p.phase !== 'done');
    });
}

/**
 * 等首次全量加载完成（不会 reject）。
 *
 * 给「不进本地音乐页面也要用这份数据」的地方用（例如歌词管理弹窗）；
 * 已经加载过时立刻返回。
 */
export function whenLocalMusicLoaded(): Promise<void> {
    if (!initialized) ensureLocalMusicStore();
    return firstLoad ?? Promise.resolve();
}
