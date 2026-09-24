/**
 * pluginActions — 插件通用操作（更新 / 卸载）
 *
 * 插件管理页与各处「插件标签」右键菜单共用这些操作，
 * 保证不同入口的确认弹窗与结果提示完全一致。
 *
 * 注意：这里使用 i18n 单例的 t（非 Hook 版本），因为调用发生在
 * 命令式回调（右键菜单项 / 确认弹窗回调）中，而非组件渲染期间。
 */

import pluginManager from '@infra/pluginManager/renderer';
import i18n from '@infra/i18n/renderer';
import { showModal } from '../components/ui/Modal/modalManager';
import { showToast } from '../components/ui/Toast';

/**
 * 更新单个插件并弹出结果提示。
 *
 * @param hash    插件 hash
 * @param platform 插件平台名（用于提示文案）
 * @returns 是否更新成功
 */
export async function updatePluginWithToast(hash: string, platform: string): Promise<boolean> {
    try {
        const result = await pluginManager.updatePlugin(hash);
        if (result.success) {
            showToast(i18n.t('plugin.toast_plugin_updated', { plugin: platform }));
            return true;
        }
        showToast(i18n.t('plugin.toast_plugin_already_latest', { plugin: platform }));
        return false;
    } catch {
        showToast(i18n.t('plugin.update_failed'), { type: 'warn' });
        return false;
    }
}

/**
 * 弹出卸载确认框，确认后卸载插件并提示结果。
 *
 * @param hash     插件 hash
 * @param platform 插件平台名（用于提示文案）
 */
export function confirmUninstallPlugin(hash: string, platform: string): void {
    showModal('ConfirmModal', {
        title: i18n.t('plugin.uninstall_plugin'),
        message: i18n.t('plugin.uninstall_warning'),
        description: i18n.t('plugin.confirm_text_uninstall_plugin', {
            plugin: platform,
        }),
        confirmText: i18n.t('plugin.confirm_uninstall'),
        confirmDanger: true,
        onConfirm: async () => {
            const result = await pluginManager.uninstallPlugin(hash);
            if (result.success) {
                showToast(
                    i18n.t('plugin.uninstall_successfully', {
                        plugin: platform,
                    }),
                );
            } else {
                showToast(result.message ?? i18n.t('plugin.uninstall_failed'), {
                    type: 'warn',
                });
                throw new Error('uninstall failed');
            }
        },
    });
}

/**
 * 插件是否可更新（配置了更新源）。
 * 内建插件 / 本地安装的插件没有 srcUrl，无法通过更新源升级。
 */
export function canUpdatePlugin(hash: string): boolean {
    return !!pluginManager.getPluginByHash(hash)?.srcUrl;
}
