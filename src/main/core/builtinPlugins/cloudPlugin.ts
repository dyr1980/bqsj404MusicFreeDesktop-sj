/**
 * 内置「云盘」插件
 *
 * 云盘（WebDAV）上的音频文件直接作为可播放音源：
 * getMediaSource 返回主进程生成的本地转发地址（带 Basic Auth，支持 Range）。
 *
 * 注意：故意不实现 search —— 这样它不会进入「自动换源」的插件搜索链。
 * 取源优先级（本地 → 云盘 → 插件）由 trackPlayer 侧的显式逻辑保证。
 */

import { CLOUD_PLUGIN_NAME } from '@common/constant';
import cloudDisk from '@infra/cloudDisk/main';

const cloudPluginDefine: IPlugin.IPluginInstance = {
    platform: CLOUD_PLUGIN_NAME,
    _path: '', // 内建插件不从磁盘加载
    async getMediaSource(musicItem) {
        const remotePath = (musicItem.cloudPath as string) || musicItem.id;
        const url = cloudDisk.buildStreamUrl(remotePath);
        if (!url) {
            throw new Error('WebDAV 未配置：请先在「设置 → 云端与备份」里填写地址 / 账号 / 密码');
        }
        return { url };
    },
};

export default cloudPluginDefine;
