import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showToast } from '../../ui/Toast';
import i18n from '@infra/i18n/renderer';
import {
    DEFAULT_COVER,
    pickCoverDataUrl,
    setSheetCover,
    setSongCover,
} from '@renderer/mainWindow/core/artworkEdit';
import { ImagePlus, RotateCcw, Music4 } from 'lucide-react';

export interface ArtworkMenuContext {
    /** 编辑的是歌单封面还是单曲封面 */
    kind: 'sheet' | 'song';
    /** kind === 'sheet'：本地歌单 id */
    sheetId?: string;
    /** kind === 'song'：歌曲 */
    musicItem?: { platform: string; id: string };
    /** 当前是否已有自定义封面（决定要不要给「恢复默认封面」） */
    hasCustomCover?: boolean;
    /** 当前显示的是不是真实图片（决定要不要给「使用默认封面图」） */
    showUseDefault?: boolean;
}

/** 选图 → 处理 → 落库；失败给一条 toast */
async function applyCover(ctx: ArtworkMenuContext): Promise<void> {
    try {
        const dataUrl = await pickCoverDataUrl();
        if (!dataUrl) return; // 用户取消

        if (ctx.kind === 'sheet') {
            if (!ctx.sheetId) return;
            await setSheetCover(ctx.sheetId, dataUrl);
        } else {
            if (!ctx.musicItem) return;
            await setSongCover(ctx.musicItem.platform, String(ctx.musicItem.id), dataUrl);
        }
        showToast(i18n.t('artwork.changed'));
    } catch (e) {
        showToast(i18n.t('artwork.failed'), {
            type: 'warn',
            description: e instanceof Error ? e.message : `${e}`,
        });
    }
}

/** 清掉自定义封面，退回歌曲自带 / 默认图 */
async function resetCover(ctx: ArtworkMenuContext): Promise<void> {
    try {
        if (ctx.kind === 'sheet') {
            if (!ctx.sheetId) return;
            await setSheetCover(ctx.sheetId, null);
        } else {
            if (!ctx.musicItem) return;
            await setSongCover(ctx.musicItem.platform, String(ctx.musicItem.id), null);
        }
        showToast(i18n.t('artwork.reset_done'));
    } catch (e) {
        showToast(i18n.t('artwork.failed'), {
            type: 'warn',
            description: e instanceof Error ? e.message : `${e}`,
        });
    }
}

/** 强制使用内置默认封面图（不看歌曲/歌单自带封面） */
async function useDefaultCover(ctx: ArtworkMenuContext): Promise<void> {
    try {
        if (ctx.kind === 'sheet') {
            if (!ctx.sheetId) return;
            await setSheetCover(ctx.sheetId, DEFAULT_COVER);
        } else {
            if (!ctx.musicItem) return;
            await setSongCover(ctx.musicItem.platform, String(ctx.musicItem.id), DEFAULT_COVER);
        }
        showToast(i18n.t('artwork.use_default_done'));
    } catch (e) {
        showToast(i18n.t('artwork.failed'), {
            type: 'warn',
            description: e instanceof Error ? e.message : `${e}`,
        });
    }
}

/**
 * ArtworkMenu — 封面右键菜单
 *
 * 主窗口歌单头部封面、播放界面的专辑图都用它。
 *
 * 三个动作的区别：
 *   - 更换封面      ：选一张本地图，存成 dataURL
 *   - 恢复默认封面  ：清掉自定义值 → 退回歌曲/歌单**自带**封面（没有才用默认图）
 *   - 使用默认封面图：强制用内置的墨笔谱号，连自带封面也不看
 */
export function ArtworkMenu(ctx: ArtworkMenuContext): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [
        {
            id: 'change-cover',
            icon: <ImagePlus />,
            label: i18n.t('artwork.change_cover'),
            onClick() {
                void applyCover(ctx);
            },
        },
    ];

    if (ctx.showUseDefault) {
        entries.push({
            id: 'use-default-cover',
            icon: <Music4 />,
            label: i18n.t('artwork.use_default'),
            onClick() {
                void useDefaultCover(ctx);
            },
        });
    }

    if (ctx.hasCustomCover) {
        entries.push({
            id: 'reset-cover',
            icon: <RotateCcw />,
            label: i18n.t('artwork.reset_cover'),
            onClick() {
                void resetCover(ctx);
            },
        });
    }

    return entries;
}
