/**
 * themepack — 主进程层
 *
 * 职责：跨窗口广播「主题已切换」事件，并同步主窗口的原生底色。
 * 所有文件 I/O 和 DOM 操作在 preload 层完成。
 */
import { ipcMain } from 'electron';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type { IThemeSwitchedPayload } from '@appTypes/infra/themepack';
import logger from '@infra/logger/main';
import { setDefaultCoverPalette } from '@main/core/coverBitmap';
import { IPC } from './common/constant';

class ThemePack {
    private isSetup = false;

    public setup(windowManager: IWindowManager) {
        if (this.isSetup) return;

        // 主窗口切换主题后通知 main，main 将事件广播到所有窗口
        ipcMain.on(IPC.THEME_SWITCHED, (_event, payload?: IThemeSwitchedPayload) => {
            // 把主题底色同步给窗口：窗口在「还没绘制出第一帧」时露出的就是它，
            // 浅色主题下如果还留着深色底，用户看到的就是一片黑
            const baseColor = payload?.baseColor;
            if (typeof baseColor === 'string' && baseColor) {
                windowManager.setWindowBackgroundColor(baseColor);
            }

            // 托盘菜单 / 任务栏缩略图的默认封面底图由主进程自己合成，
            // 这里把渲染进程解析好的主题色转交给 coverBitmap
            setDefaultCoverPalette(payload?.coverPalette);
            logger.debug('[ThemePack] default cover palette', payload?.coverPalette ?? null);

            windowManager.broadcast(IPC.THEME_SWITCHED);
        });

        this.isSetup = true;
    }
}

const themePack = new ThemePack();
export default themePack;
