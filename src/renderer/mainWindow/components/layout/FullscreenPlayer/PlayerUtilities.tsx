// ============================================================================
// PlayerUtilities — 播放详情页左侧工具行
// ============================================================================
//
// 把播放栏上的「下载 / 音质 / 倍速 / 音量」搬到全屏播放页左侧封面下方，
// 直接复用 PlayerBar 里的现成组件，行为与播放栏完全一致：
//   - DownloadButton：按下载状态切换图标
//   - QualityPopover / SpeedPopover / VolumePopover：hover 出气泡面板
//
// 末尾是「迷你模式」+「收至托盘」两个窗口入口：它们跟着音量按钮排在工具行里，
// 而不是放到右上角——右上角只有关闭页面的箭头，再加图标会被当成最小化/关闭。
//
// 气泡在播放栏里是「向上弹」，这里按钮排在封面下方，
// 由 index.scss 的 __tool--side 覆盖成「向右弹」，避免超出屏幕。

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import systemUtil from '@infra/systemUtil/renderer';
import { MiniModeShrink, TrayCollapse } from '@renderer/common/icons';
import { useCurrentMusic } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { DownloadButton } from '../../business/DownloadButton';
import { CloudButton } from '../../business/CloudButton';
import QualityPopover from '../PlayerBar/QualityPopover';
import SpeedPopover from '../PlayerBar/SpeedPopover';
import VolumePopover from '../PlayerBar/VolumePopover';

const PlayerUtilities = memo(function PlayerUtilities() {
    const { t } = useTranslation();
    const currentMusic = useCurrentMusic();

    return (
        <div className="l-fullscreen-player__utilities">
            {currentMusic && (
                <>
                    <DownloadButton musicItem={currentMusic} size="sm" />
                    <CloudButton musicItem={currentMusic} size="sm" />
                </>
            )}
            <QualityPopover />
            <SpeedPopover />
            <VolumePopover />
            <button
                type="button"
                className="l-player-bar__ctrl-btn"
                title={t('app.enter_minimode')}
                aria-label={t('app.enter_minimode')}
                onClick={() => systemUtil.enterMinimode()}
            >
                <MiniModeShrink size={15} />
            </button>
            {/* 收至托盘：与迷你模式入口并排，行为同标题栏「最小化到托盘」 */}
            <button
                type="button"
                className="l-player-bar__ctrl-btn"
                title={t('app.minimize_to_tray')}
                aria-label={t('app.minimize_to_tray')}
                onClick={() => systemUtil.minimizeWindow(true)}
            >
                <TrayCollapse size={15} />
            </button>
        </div>
    );
});

export default PlayerUtilities;
