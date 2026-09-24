// ============================================================================
// PlayerBar — 底部播放栏
// ============================================================================

import { SkipBack, SkipForward, Play, Pause, ListMusic, Maximize2 } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DesktopLyric } from '@renderer/common/icons';
import { cn } from '@common/cn';
import { PlayerState } from '@common/constant';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import appConfig from '@infra/appConfig/renderer';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { useRovingFocus } from '@renderer/common/hooks/useRovingFocus';
import { FavoriteButton } from '../../business/FavoriteButton';
import { DownloadButton } from '../../business/DownloadButton';
import { CloudButton } from '../../business/CloudButton';
import { displayPlatform } from '@renderer/mainWindow/core/sourceLabel';
import {
    useCurrentMusic,
    usePlayerState,
    useRepeatMode,
} from '@renderer/mainWindow/core/trackPlayer/hooks';
import { REPEAT_MODE_MAP } from '@renderer/common/repeatModeMap';
import { Artwork } from '../../ui/Artwork';
import { Marquee } from '../../ui/Marquee';
import { toggleQueueDrawer } from '../QueueDrawer/queueDrawerState';
import { openFullscreenPlayer } from '../FullscreenPlayer/fullscreenPlayerState';
import { showCurrentMusicMenu } from '@renderer/mainWindow/core/currentMusicMenu';
import { useCoverAllowed } from '@renderer/common/coverLoad';
import { normalizeCover, useSongCover } from '@renderer/mainWindow/core/artworkEdit';
import SourceIndicator from '../SourceStatusBar';
import { ProgressBar, TimeDisplay } from './ProgressBar';
import VolumePopover from './VolumePopover';
import SpeedPopover from './SpeedPopover';
import QualityPopover from './QualityPopover';
import './index.scss';

// ─── PlayerBar ───

/**
 * PlayerBar
 * @layer layout
 *
 * 底部固定播放栏，三列布局：
 * - 左侧：封面 + 歌曲信息（Marquee 滚动）
 * - 中间：播放控制（上/下一首、播放/暂停、播放模式、歌词）
 * - 右侧：音质、倍速气泡、音量气泡、播放列表
 *
 * 进度条独立为 ProgressBar 子组件隔离高频更新。
 * 音量、倍速各自独立为垂直气泡面板子组件。
 */
export default function PlayerBar() {
    const { t } = useTranslation();
    const currentMusic = useCurrentMusic();
    const playerState = usePlayerState();
    const repeatMode = useRepeatMode();

    const [enableDesktopLyric] = useConfigValue('lyric.enableDesktopLyric');

    const isPlaying = playerState === PlayerState.Playing;
    const hasMusic = currentMusic != null;

    /**
     * 播放栏控制组（横向焦点组）：
     * 封面（展开播放详情）/ 桌面歌词 / 上一首 / 播放 / 下一首 / 循环
     * + 音质 / 倍速 / 音量 / 队列 = 10 项。
     * Tab 进组一次，方向键由 core/spatialFocus 按位置移动。
     */
    const roving = useRovingFocus<HTMLDivElement>({ orientation: 'horizontal', itemCount: 10 });

    const { Icon: RepeatIcon, tipKey: repeatTipKey } = REPEAT_MODE_MAP[repeatMode];

    /** 封面：用户自定义优先（与全屏播放页保持一致）；哨兵值 → 用内置默认图 */
    const customCover = useSongCover(currentMusic);
    const coverMusicItem = currentMusic ?? null;
    // 「封面加载」关掉歌曲封面时，只跳过网络封面；本地自定义封面照常显示
    const songCoverAllowed = useCoverAllowed('song');
    const coverSrc =
        normalizeCover(customCover) ??
        (songCoverAllowed ? normalizeCover(coverMusicItem?.artwork) : undefined) ??
        undefined;

    /**
     * 播放状态栏空白处右键 → 当前播放歌曲的菜单。
     *
     * 点在按钮 / 进度条 / 封面等控件上时由它们自己处理（或压根不该弹），
     * 所以这里只认「冒泡上来且没人 preventDefault、也不在任何控件里」的右键。
     */
    const handleBlankContextMenu = useCallback(
        (e: React.MouseEvent<HTMLElement>) => {
            if (e.defaultPrevented) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, a, input, [role="slider"], .context-menu')) return;
            if (!hasMusic) return;
            showCurrentMusicMenu(e.clientX, e.clientY);
        },
        [hasMusic],
    );

    return (
        <footer className="l-player-bar" onContextMenu={handleBlankContextMenu}>
            {/* ── 进度条（独立组件，隔离高频更新） ── */}
            <ProgressBar />

            {/* ── 三列布局 ── */}
            <div className="l-player-bar__body" {...roving.containerProps}>
                {/* ── 左侧: 歌曲信息（两行布局） ── */}
                <div className="l-player-bar__left">
                    {/*
                      封面 = 「展开播放详情」的入口。它是可点击控件，所以必须是真正的
                      button（有 title/aria-label、能 Tab 到、能 Enter/Space 触发），
                      否则键盘用户根本到不了这个入口。
                      没有歌曲时退回纯展示（不再是焦点目标）。
                    */}
                    {hasMusic ? (
                        <button
                            type="button"
                            className="l-player-bar__cover-btn"
                            data-roving-item
                            title={t('playback.expand_player_detail')}
                            aria-label={t('playback.expand_player_detail')}
                            onClick={openFullscreenPlayer}
                            // Enter / Space 显式处理：preventDefault 掉原生 click，
                            // 避免和 onClick 双触发（也顺手挡掉空格滚页面）
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                openFullscreenPlayer();
                            }}
                        >
                            <Artwork
                                src={coverSrc}
                                size="sm"
                                rounded="sm"
                                className="l-player-bar__cover"
                                overlay={<Maximize2 size={16} />}
                            />
                        </button>
                    ) : (
                        <Artwork
                            src={coverSrc}
                            size="sm"
                            rounded="sm"
                            className="l-player-bar__cover"
                        />
                    )}
                    <div className="l-player-bar__info">
                        {hasMusic ? (
                            <>
                                {/* 第一行: 歌名 · 歌手 · 来源 — 点击打开全屏播放器 */}
                                <Marquee
                                    className="l-player-bar__info-row"
                                    onClick={openFullscreenPlayer}
                                >
                                    <span className="l-player-bar__title">
                                        {currentMusic.title}
                                    </span>
                                    {currentMusic.artist && (
                                        <>
                                            <span className="l-player-bar__dot">·</span>
                                            <span className="l-player-bar__artist">
                                                {currentMusic.artist}
                                            </span>
                                        </>
                                    )}
                                    {currentMusic.platform && (
                                        <>
                                            <span className="l-player-bar__dot">·</span>
                                            <span className="l-player-bar__source-badge">
                                                {displayPlatform(currentMusic.platform, t)}
                                            </span>
                                        </>
                                    )}
                                </Marquee>
                                {/* 第二行: 喜欢、下载、云端、分割线、时间、音源 */}
                                <div className="l-player-bar__actions">
                                    <FavoriteButton musicItem={currentMusic} size="md" />
                                    <DownloadButton musicItem={currentMusic} size="md" />
                                    <CloudButton musicItem={currentMusic} size="md" />
                                    <div className="l-player-bar__divider" />
                                    <TimeDisplay />
                                    <SourceIndicator />
                                </div>
                            </>
                        ) : (
                            <span className="l-player-bar__empty-hint">
                                {t('playback.not_playing')}
                            </span>
                        )}
                    </div>
                </div>

                {/* ── 中间: 播放控制 ── */}
                <div className="l-player-bar__center">
                    <button
                        className={cn('l-player-bar__ctrl-btn', enableDesktopLyric && 'is-active')}
                        type="button"
                        data-roving-item
                        title={t('playback.desktop_lyric')}
                        onClick={() => {
                            appConfig.setConfig({
                                'lyric.enableDesktopLyric': !enableDesktopLyric,
                            });
                        }}
                    >
                        <DesktopLyric size={15} />
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--lg"
                        type="button"
                        data-roving-item
                        title={t('playback.previous')}
                        onClick={() => trackPlayer.skipToPrev()}
                    >
                        <SkipBack size={17} fill="currentColor" />
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--play"
                        type="button"
                        data-roving-item
                        title={isPlaying ? t('playback.pause') : t('playback.play')}
                        onClick={() => trackPlayer.togglePlayPause()}
                    >
                        {isPlaying ? (
                            <Pause size={18} fill="currentColor" />
                        ) : (
                            // 播放三角形视觉居中补偿 2px
                            <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
                        )}
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--lg"
                        type="button"
                        data-roving-item
                        title={t('playback.next')}
                        onClick={() => trackPlayer.skipToNext()}
                    >
                        <SkipForward size={17} fill="currentColor" />
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn"
                        type="button"
                        data-roving-item
                        title={t(repeatTipKey)}
                        onClick={() => trackPlayer.toggleRepeatMode()}
                    >
                        <RepeatIcon size={15} />
                    </button>
                </div>

                {/* ── 右侧: 工具 ── */}
                <div className="l-player-bar__right">
                    <QualityPopover />
                    <SpeedPopover />
                    <VolumePopover />

                    <div className="l-player-bar__divider l-player-bar__divider--tall" />
                    <button
                        className="l-player-bar__ctrl-btn"
                        data-click-outside-ignore
                        type="button"
                        data-roving-item
                        title={t('playback.show_queue')}
                        onClick={toggleQueueDrawer}
                    >
                        <ListMusic size={15} />
                    </button>
                </div>
            </div>
        </footer>
    );
}
