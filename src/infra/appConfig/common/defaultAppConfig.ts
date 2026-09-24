/**
 * appConfig — 默认配置值
 *
 * 提供应用配置的默认值，作为配置加载失败或重置时的回退。
 */
import type { IAppConfig } from '@appTypes/infra/appConfig';

const defaultAppConfig: IAppConfig = {
    '$schema-version': 1,
    'playMusic.whenQualityMissing': 'lower',
    'playMusic.defaultQuality': 'standard',
    'playMusic.clickMusicList': 'replace',
    'playMusic.caseSensitiveInSearch': false,
    'playMusic.playError': 'skip',
    'playMusic.whenDeviceRemoved': 'play',
    'normal.taskbarThumb': 'window',
    'normal.autoLoadCover': 'all',
    'normal.closeBehavior': 'minimize',
    'normal.checkUpdate': true,
    'normal.maxHistoryLength': 30,
    'download.defaultQuality': 'standard',
    'download.whenQualityMissing': 'lower',
    'lyric.enableDesktopLyric': false,
    'lyric.alwaysOnTop': true,
    'lyric.lockLyric': false,
    'lyric.fontData': null,
    'lyric.fontColor': '#ffffff',
    'lyric.strokeColor': '#f5c542',
    'lyric.fontSize': 48,
    'lyric.autoSearchLyric': true,
    'shortCut.enableLocal': true,
    'shortCut.enableGlobal': false,
    'download.concurrency': 5,
    'download.lyricPath': '',
    'normal.musicListHideColumns': ['duration'],
    'backup.resumeBehavior': 'append',
    'backup.uploadLocalFiles': false,
    'backup.uploadLyrics': true,
    'backup.autoBackup': false,
    'backup.syncPendingAt': 0,
    'backup.lastSyncAt': 0,
    'normal.language': 'zh-CN',
    'normal.useCustomTrayMenu': true,
};

export default defaultAppConfig;
