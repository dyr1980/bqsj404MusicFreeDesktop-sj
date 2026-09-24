/**
 * Command Handlers — 非 TrackPlayer 的 appSync 指令处理
 *
 * 注册 toggle-desktop-lyric、toggle-minimode 等快捷键指令的 renderer 端 handler。
 * 在 bootstrap 中 trackPlayer.setup() 之后调用。
 */
import appConfig from '@infra/appConfig/renderer';
import appSync from '@infra/appSync/renderer/main';
import systemUtil from '@infra/systemUtil/renderer';
import { openFullscreenPlayer } from '@renderer/mainWindow/components/layout/FullscreenPlayer/fullscreenPlayerState';
import router from '@renderer/mainWindow/router';
import { handleSheetImportDeeplink } from '@renderer/mainWindow/core/sheetShare/handleDeepLink';
import {
    runCurrentMusicMenuAction,
    showCurrentMusicMenuNative,
} from '@renderer/mainWindow/core/currentMusicMenu';

export function setupCommandHandlers(): void {
    appSync.onCommand('toggle-desktop-lyric', () => {
        const current = appConfig.getConfigByKey('lyric.enableDesktopLyric');
        appConfig.setConfig({ 'lyric.enableDesktopLyric': !current });
    });

    appSync.onCommand('toggle-minimode', () => {
        systemUtil.toggleMinimode();
    });

    appSync.onCommand('open-music-detail', () => {
        openFullscreenPlayer();
    });

    appSync.onCommand('navigate', (path) => {
        router.navigate('/' + path);
    });

    // 歌单分享：深链带入片段时打开导入弹窗并自动解码，否则打开弹窗让用户选图/粘贴
    appSync.onCommand('import-shared-sheet', () => {
        handleSheetImportDeeplink();
    });

    appSync.onCommand('import-shared-sheet-text', (fragment) => {
        handleSheetImportDeeplink(fragment);
    });

    // 迷你窗口空白处右键：这边构建「当前歌曲」菜单，交给主进程弹系统菜单；
    // 点了哪一项再从主进程发回来，在这里执行
    appSync.onCommand('open-current-music-menu', ({ x, y }) => {
        showCurrentMusicMenuNative(x, y);
    });

    appSync.onCommand('run-current-music-menu-action', (id) => {
        runCurrentMusicMenuAction(id);
    });
}
