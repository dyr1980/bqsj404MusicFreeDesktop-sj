/**
 * 封面加载策略 — 共享判定
 *
 * 网络封面图是通过 `<img src>` 加载的：**只要渲染出来，浏览器就会去下载，就会产生流量**
 * （不显示就已经加载过的图，流量照样花掉了）。所以「不自动加载」必须同时做到两件事：
 *   1. 不渲染这些封面图（这是流量的主要来源）
 *   2. 歌曲封面还要额外停掉 `getMusicInfo` 那次补全请求（插件详情接口，可能带回新封面）
 *
 * 分类只有两类，避免选项组合爆炸：
 *   - song ：歌曲封面（播放状态栏 / 全屏播放页 / 迷你窗口 / 换源、搜歌词列表）
 *   - sheet：歌单封面（歌单头部 / 歌单卡片 / 排行榜卡片 / 添加到歌单弹窗）
 *
 * 不受影响（属于本地数据，不走网络）：
 *   - 右键「更换封面」设置的本地封面（dataURL）
 *   - 本地音乐文件内嵌的封面
 */
import appConfig from '@infra/appConfig/renderer';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import type { IAppConfig } from '@appTypes/infra/appConfig';

export type CoverKind = 'song' | 'sheet';
export type CoverLoadMode = IAppConfig['normal.autoLoadCover'];

/** 纯函数判定：给定策略，某一类封面是否允许自动加载 */
export function isCoverAllowed(mode: CoverLoadMode | undefined, kind: CoverKind): boolean {
    switch (mode ?? 'all') {
        case 'none':
            return false;
        case 'sheet':
            return kind === 'sheet';
        case 'song':
            return kind === 'song';
        default:
            return true;
    }
}

/** 同步读取当前策略（非 React 环境用，如 trackPlayer） */
export function getCoverLoadMode(): CoverLoadMode {
    return appConfig.getConfigByKey('normal.autoLoadCover') ?? 'all';
}

/** 同步判定（非 React 环境用） */
export function isCoverAutoLoadEnabled(kind: CoverKind): boolean {
    return isCoverAllowed(getCoverLoadMode(), kind);
}

/** React 侧订阅：某一类封面当前是否允许自动加载 */
export function useCoverAllowed(kind: CoverKind): boolean {
    const [mode] = useConfigValue('normal.autoLoadCover');
    return isCoverAllowed(mode, kind);
}
