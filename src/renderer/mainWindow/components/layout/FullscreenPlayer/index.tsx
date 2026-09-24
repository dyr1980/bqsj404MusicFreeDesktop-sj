// ============================================================================
// FullscreenPlayer — 全屏播放详情页
// ============================================================================

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Languages, ListMusic } from 'lucide-react';
import { DesktopLyric, LyricSettingsIcon } from '@renderer/common/icons';
import { useAtomValue } from 'jotai/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@common/cn';
import { transition as motionTransition } from '@common/motionTokens';
import { useCurrentMusic, useLyric } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { DefaultCover } from '@renderer/common/DefaultCover';
import { useCoverAllowed } from '@renderer/common/coverLoad';
import { normalizeCover, useSongCover } from '@renderer/mainWindow/core/artworkEdit';
import { showContextMenu } from '../../ui/ContextMenu/contextMenuManager';
import { syncKV } from '@renderer/common/kvStore';
import { fullscreenPlayerOpenAtom, closeFullscreenPlayer } from './fullscreenPlayerState';
import LyricPanel from './LyricPanel';
import LyricSettingsPopover from './LyricSettingsPopover';
import PlaybackControls from './PlaybackControls';
import PlayerUtilities from './PlayerUtilities';
import { toggleQueueDrawer } from '../QueueDrawer/queueDrawerState';
import { showCurrentMusicMenu } from '@renderer/mainWindow/core/currentMusicMenu';
import { OVERLAY_LAYER, registerOverlay } from '@renderer/mainWindow/core/overlay';
import './index.scss';

// ─── 动画配置 ───

const overlayVariants = {
    hidden: { y: '100%', opacity: 0 },
    visible: { y: 0, opacity: 1 },
};

/**
 * FullscreenPlayer — 布局组件
 *
 * 全屏覆盖层，展示当前播放歌曲的封面、歌词。
 * 从底部滑入，Escape 或点击 Header 返回按钮关闭。
 */
const FullscreenPlayer = memo(function FullscreenPlayer() {
    const open = useAtomValue(fullscreenPlayerOpenAtom);
    const currentMusic = useCurrentMusic();
    const { t } = useTranslation();

    // 歌词设置状态
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [fontScale, setFontScale] = useState(() => syncKV.get('player.lyricFontScale') ?? 1);
    const [showTranslation, setShowTranslation] = useState(
        () => syncKV.get('player.showLyricTranslation') ?? true,
    );

    // Escape：注册给全局裁决（core/overlay）；有选中项时先清选中，不退出全屏
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        return registerOverlay({
            layer: OVERLAY_LAYER.fullscreen,
            element: () => rootRef.current,
            close: closeFullscreenPlayer,
        });
    }, [open]);

    // 关闭时收起设置面板
    useEffect(() => {
        if (!open) {
            setSettingsOpen(false);
        }
    }, [open]);

    // 打开期间把主界面设为 inert。
    //
    // 全屏页是 portal 到 document.body 的覆盖层，底下的主界面（底栏、列表、侧栏）仍然
    // 留在 DOM 里、**仍然在 Tab 顺序里** —— 于是 Tab 会落到被覆盖层盖住的控件上，焦点环
    // 画在覆盖层下面（完全看不见）。inert 让这棵子树整体不可聚焦、不可点、对读屏隐藏。
    // 所有浮层（弹窗 / 抽屉 / 下拉 / 全屏页自己）都 portal 到 body，不受影响。
    useEffect(() => {
        const root = document.getElementById('root');
        if (!root) return;
        if (open) {
            root.setAttribute('inert', '');
        } else {
            root.removeAttribute('inert');
        }
        return () => root.removeAttribute('inert');
    }, [open]);

    /** 字号缩放变化 — 持久化到 SyncKV */
    const handleFontScaleChange = useCallback((scale: number) => {
        setFontScale(scale);
        syncKV.set('player.lyricFontScale', scale);
    }, []);

    /** 翻译开关变化 — 持久化到 SyncKV */
    const handleShowTranslationChange = useCallback((show: boolean) => {
        setShowTranslation(show);
        syncKV.set('player.showLyricTranslation', show);
    }, []);

    /** 关闭设置面板 */
    const handleSettingsClose = useCallback(() => {
        setSettingsOpen(false);
    }, []);

    const settingsTriggerRef = useRef<HTMLButtonElement>(null);

    /** 用户自定义封面（mediaMeta）优先于歌曲自带封面；哨兵值 → 用内置默认图 */
    const customCover = useSongCover(currentMusic);
    // 「封面加载」关掉歌曲封面时，只跳过网络封面；本地自定义封面照常显示
    const songCoverAllowed = useCoverAllowed('song');
    const artworkSrc =
        normalizeCover(customCover) ??
        (songCoverAllowed ? normalizeCover(currentMusic?.artwork) : undefined);
    /** 封面加载失败时退回默认音符图 */
    const [artworkFailed, setArtworkFailed] = useState(false);
    useEffect(() => {
        setArtworkFailed(false);
    }, [artworkSrc]);
    const showDefaultCover = !artworkSrc || artworkFailed;

    /** 封面右键：更换 / 恢复默认封面 */
    const handleArtworkContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (!currentMusic) return;
            e.preventDefault();
            showContextMenu(
                'ArtworkMenu',
                { x: e.clientX, y: e.clientY },
                {
                    kind: 'song',
                    musicItem: { platform: currentMusic.platform, id: String(currentMusic.id) },
                    hasCustomCover: !!customCover,
                    showUseDefault: !!artworkSrc,
                },
            );
        },
        [currentMusic, customCover],
    );

    // 歌词状态（翻译可用性）
    const lyricState = useLyric();
    const hasTranslation = lyricState?.parser?.hasTranslation ?? false;

    // 桌面歌词状态
    const [desktopLyricEnabled, setDesktopLyricEnabled] = useConfigValue(
        'lyric.enableDesktopLyric',
    );

    const handleDesktopLyricToggle = useCallback(() => {
        setDesktopLyricEnabled(!desktopLyricEnabled);
    }, [desktopLyricEnabled, setDesktopLyricEnabled]);

    const handleTranslationToggle = useCallback(() => {
        handleShowTranslationChange(!showTranslation);
    }, [showTranslation, handleShowTranslationChange]);

    /**
     * 全屏播放页空白处右键 → 当前播放歌曲的菜单。
     *
     * 控件与歌词面板会各自处理右键（歌词面板右键是「取消准星」并已 preventDefault），
     * 所以这里只接没人处理过的那些。
     */
    const handleBlankContextMenu = useCallback(
        (e: React.MouseEvent<HTMLElement>) => {
            if (e.defaultPrevented) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, a, input, [role="slider"], .context-menu')) return;
            if (!currentMusic) return;
            showCurrentMusicMenu(e.clientX, e.clientY);
        },
        [currentMusic],
    );

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    ref={rootRef}
                    className="l-fullscreen-player"
                    onContextMenu={handleBlankContextMenu}
                    variants={overlayVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    transition={motionTransition.slow}
                >
                    {/* ── 动态模糊背景 ── */}
                    <div className="l-fullscreen-player__bg">
                        {artworkSrc && (
                            <img
                                className="l-fullscreen-player__bg-img"
                                src={artworkSrc}
                                alt=""
                                draggable={false}
                            />
                        )}
                        <div className="l-fullscreen-player__bg-overlay" />
                    </div>

                    {/* ── Header ── */}
                    <div className="l-fullscreen-player__header">
                        <button
                            type="button"
                            className="l-fullscreen-player__close-btn"
                            onClick={closeFullscreenPlayer}
                            title={t('common.collapse')}
                            aria-label={t('playback.collapse_player_detail')}
                        >
                            <ChevronDown size={32} />
                        </button>
                    </div>

                    {/* ── Body — 左封面 + 右歌词 ── */}
                    <div className="l-fullscreen-player__body">
                        {/* 左: 封面 */}
                        <div className="l-fullscreen-player__artwork-wrapper">
                            <div
                                className={cn(
                                    'l-fullscreen-player__artwork',
                                    // 默认封面不带方块底，直接交给主题背景
                                    showDefaultCover && 'is-default',
                                )}
                                onContextMenu={handleArtworkContextMenu}
                            >
                                {showDefaultCover ? (
                                    // 无封面 / 加载失败：墨笔谱号默认图（跟随主题色）
                                    <div className="l-fullscreen-player__artwork-fallback">
                                        <DefaultCover />
                                    </div>
                                ) : (
                                    <img
                                        className="l-fullscreen-player__artwork-img"
                                        src={artworkSrc}
                                        alt={currentMusic?.title ?? ''}
                                        draggable={false}
                                        onError={() => setArtworkFailed(true)}
                                    />
                                )}
                            </div>

                            {/* 播放控制面板 */}
                            <PlaybackControls />

                            {/* 下载 / 音质 / 倍速 / 音量 */}
                            <PlayerUtilities />
                        </div>

                        {/* 右: 歌词区域 */}
                        <div className="l-fullscreen-player__right">
                            {/* 歌曲信息 */}
                            <div className="l-fullscreen-player__song-info">
                                <h2 className="l-fullscreen-player__song-title">
                                    {currentMusic?.title ?? t('playback.not_playing')}
                                </h2>
                                <p className="l-fullscreen-player__song-artist">
                                    {currentMusic?.artist && (
                                        <>
                                            {currentMusic.artist}
                                            {currentMusic.album && (
                                                <>
                                                    <span className="l-fullscreen-player__dot">
                                                        •
                                                    </span>
                                                    {currentMusic.album}
                                                </>
                                            )}
                                        </>
                                    )}
                                </p>
                            </div>

                            {/* 歌词面板 */}
                            <div className="l-fullscreen-player__lyric-container">
                                <LyricPanel
                                    fontScale={fontScale}
                                    showTranslation={showTranslation}
                                />

                                {/* 右下角工具栏：翻译 / 桌面歌词 / 设置 */}
                                <div className="l-fullscreen-player__settings-anchor">
                                    <button
                                        className={cn(
                                            'l-fullscreen-player__tool-btn',
                                            showTranslation && hasTranslation && 'is-active',
                                            !hasTranslation && 'is-disabled',
                                        )}
                                        type="button"
                                        title={
                                            !hasTranslation
                                                ? t('lyric.no_translation')
                                                : showTranslation
                                                  ? t('lyric.hide_translation')
                                                  : t('lyric.show_translation')
                                        }
                                        aria-label={t('lyric.translation')}
                                        aria-pressed={showTranslation && hasTranslation}
                                        disabled={!hasTranslation}
                                        onClick={handleTranslationToggle}
                                    >
                                        <Languages size={16} />
                                    </button>
                                    <button
                                        className={cn(
                                            'l-fullscreen-player__tool-btn',
                                            desktopLyricEnabled && 'is-active',
                                        )}
                                        type="button"
                                        title={
                                            desktopLyricEnabled
                                                ? t('lyric.close_desktop')
                                                : t('lyric.open_desktop')
                                        }
                                        aria-label={t('playback.desktop_lyric')}
                                        aria-pressed={!!desktopLyricEnabled}
                                        onClick={handleDesktopLyricToggle}
                                    >
                                        <DesktopLyric size={16} />
                                    </button>
                                    <button
                                        ref={settingsTriggerRef}
                                        type="button"
                                        className={cn(
                                            'l-fullscreen-player__tool-btn',
                                            'l-fullscreen-player__tool-btn--settings',
                                            settingsOpen && 'is-panel-open',
                                        )}
                                        onClick={() => setSettingsOpen((prev) => !prev)}
                                        title={t('lyric.settings')}
                                        aria-label={t('lyric.settings')}
                                    >
                                        <LyricSettingsIcon size={16} />
                                    </button>

                                    <LyricSettingsPopover
                                        open={settingsOpen}
                                        onClose={handleSettingsClose}
                                        triggerRef={settingsTriggerRef}
                                        fontScale={fontScale}
                                        onFontScaleChange={handleFontScaleChange}
                                    />

                                    {/* 播放列表：排在歌词设置下方 */}
                                    <button
                                        type="button"
                                        className="l-fullscreen-player__tool-btn"
                                        onClick={toggleQueueDrawer}
                                        title={t('playback.show_queue')}
                                        aria-label={t('playback.show_queue')}
                                    >
                                        <ListMusic size={16} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
});

export default FullscreenPlayer;
