/**
 * sourceLabel — 界面上「来源」怎么显示
 *
 * 平台标识（`item.platform`）有时是内部名，直接显示会露出实现细节：
 *   - `云盘` 是内置云盘插件的平台名（DB 里、插件注册名都是它，不能乱改），
 *     但界面上统一叫「云端」
 *   - 其余（插件名、`本地`）照原样显示
 *
 * 用法：`displayPlatform(item.platform, t)`。传 `t` 而不是直接引 i18n，
 * 是为了让切换语言时组件跟着重渲染。
 */

import { CLOUD_PLUGIN_NAME } from '@common/constant';

type Translate = (key: string) => string;

/** 平台标识 → 界面显示名 */
export function displayPlatform(platform: string | undefined | null, t: Translate): string {
    if (!platform) return '';
    if (platform === CLOUD_PLUGIN_NAME) return t('common.cloud');
    return platform;
}
