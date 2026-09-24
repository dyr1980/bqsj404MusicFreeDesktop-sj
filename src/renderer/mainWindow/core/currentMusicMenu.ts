/**
 * 「当前播放歌曲」的右键菜单
 *
 * 三个入口共用同一份菜单内容（与歌单里右键歌曲完全一致，只是语境固定为播放队列）：
 *   1. 主窗口底部播放状态栏的空白处  → 应用内菜单
 *   2. 全屏播放页的空白处            → 应用内菜单
 *   3. 迷你窗口的空白处              → 系统原生菜单
 *
 * 为什么迷你窗口要走原生菜单：那个窗口只有 420×120，而浏览器窗口会把内容裁在
 * 窗口边界内，这份菜单有 6~8 项、约 290px 高，直接渲染会被切掉大半。
 * 原生菜单是系统级弹窗，不受父窗口尺寸限制。
 */
import type { ContextMenuEntry, ContextMenuItemDef } from '../components/ui/ContextMenu';
import { showContextMenu } from '../components/ui/ContextMenu/contextMenuManager';
import { MusicItemMenu } from '../components/business/contextMenus/MusicItemMenu';
import { PLAY_QUEUE_SHEET_ID } from '@infra/musicSheet/common/constant';
import systemUtil from '@infra/systemUtil/renderer';
import trackPlayer from './trackPlayer';

/** 当前播放歌曲的菜单项；没有播放中的歌曲时返回 null */
function buildCurrentMusicMenu(): ContextMenuEntry[] | null {
    const current = trackPlayer.getCurrentMusic();
    if (!current) return null;

    // 直接用歌单/播放队列右键用的那份模板，保证选项一致
    return MusicItemMenu({ musicItems: current, sheetId: PLAY_QUEUE_SHEET_ID });
}

/** 跳过分隔线 */
function isMenuItem(entry: ContextMenuEntry): entry is ContextMenuItemDef {
    return !('type' in entry);
}

/**
 * 弹出应用内菜单（主窗口底部状态栏 / 全屏播放页用）。
 *
 * @returns 是否成功弹出（没有播放中的歌曲时为 false）
 */
export function showCurrentMusicMenu(x: number, y: number): boolean {
    const current = trackPlayer.getCurrentMusic();
    if (!current) return false;

    showContextMenu(
        'MusicItemMenu',
        { x, y },
        { musicItems: current, sheetId: PLAY_QUEUE_SHEET_ID },
    );
    return true;
}

/**
 * 弹出系统原生菜单（迷你窗口用）。
 *
 * 菜单内容在主窗口这边构建（只有这里有 trackPlayer / 下载 / 歌单等能力），
 * 然后交给主进程弹在迷你窗口上；点击后主进程发指令回来执行对应项。
 *
 * @param x 屏幕坐标（DIP）
 * @param y 屏幕坐标（DIP）
 */
export function showCurrentMusicMenuNative(x: number, y: number): void {
    const entries = buildCurrentMusicMenu();
    if (!entries?.length) return;

    pendingEntries = entries;

    systemUtil.popupNativeMenu({
        items: entries.map((entry) =>
            isMenuItem(entry)
                ? {
                      id: entry.id,
                      label: entry.label,
                      enabled: entry.disabled !== true,
                  }
                : { type: 'separator' as const },
        ),
        x,
        y,
        targetWindow: 'minimode',
    });
}

/** 原生菜单点击回调需要按 id 找回这一批菜单项 */
let pendingEntries: ContextMenuEntry[] = [];

/** 原生菜单点了某一项：回到主窗口执行它 */
export function runCurrentMusicMenuAction(id: string): void {
    const entry = pendingEntries.find((it) => isMenuItem(it) && it.id === id);
    pendingEntries = [];
    if (entry && isMenuItem(entry)) {
        entry.onClick?.();
    }
}
