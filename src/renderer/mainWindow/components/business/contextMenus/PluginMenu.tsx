import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showToast } from '../../ui/Toast';
import {
    canUpdatePlugin,
    confirmUninstallPlugin,
    updatePluginWithToast,
} from '@renderer/mainWindow/common/pluginActions';
import pluginManager from '@infra/pluginManager/renderer';
import i18n from '@infra/i18n/renderer';
import { ArrowUpCircle, Ban, CircleCheck, Trash2 } from 'lucide-react';

export interface PluginMenuContext {
    /** 插件 hash */
    hash: string;
    /** 插件平台名（用于提示文案） */
    platform: string;
}

/** 切换插件的启用状态（乐观更新 + 撤销入口） */
function togglePluginEnabled(hash: string, platform: string, nextEnabled: boolean): void {
    // batchSetPluginMeta 会先同步更新本地 atom（标签立即消失/出现），再异步落盘
    void pluginManager.batchSetPluginMeta([{ hash, meta: { enabled: nextEnabled } }]);

    showToast(
        nextEnabled
            ? i18n.t('plugin.enabled_toast', { plugin: platform })
            : i18n.t('plugin.disabled_toast', { plugin: platform }),
        {
            actionLabel: i18n.t('common.undo'),
            onAction() {
                void pluginManager.batchSetPluginMeta([{ hash, meta: { enabled: !nextEnabled } }]);
            },
        },
    );
}

/**
 * PluginMenu — 插件标签右键菜单模板
 *
 * 在排行榜 / 热门歌单的插件 Tab、搜索结果页的插件 Chip、
 * 换源弹窗的插件 Tab 上右键触发。
 * 提供「禁用/启用」「更新」「卸载」三项操作，行为与插件管理页保持一致。
 *
 * 更新项在插件没有更新源（srcUrl）时禁用。
 */
export function PluginMenu(ctx: PluginMenuContext): ContextMenuEntry[] {
    const { hash, platform } = ctx;
    const updatable = canUpdatePlugin(hash);
    const enabled = pluginManager.getPluginMeta()[hash]?.enabled !== false;

    return [
        {
            id: 'toggle-enabled',
            icon: enabled ? <Ban /> : <CircleCheck />,
            label: enabled ? i18n.t('plugin.disable') : i18n.t('plugin.enable'),
            onClick() {
                togglePluginEnabled(hash, platform, !enabled);
            },
        },
        {
            id: 'update',
            icon: <ArrowUpCircle />,
            label: i18n.t('plugin.update'),
            disabled: !updatable,
            onClick() {
                void updatePluginWithToast(hash, platform);
            },
        },
        { type: 'separator' },
        {
            id: 'uninstall',
            icon: <Trash2 />,
            label: i18n.t('plugin.uninstall'),
            danger: true,
            onClick() {
                confirmUninstallPlugin(hash, platform);
            },
        },
    ];
}
