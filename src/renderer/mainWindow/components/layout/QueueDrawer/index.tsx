// ============================================================================
// QueueDrawer — 播放队列抽屉
// ============================================================================
//
// 布局组件，从右侧滑入，展示当前播放队列。
// 使用 react-virtuoso 虚拟化列表以支持上万首歌曲。
// 打开时自动滚动到正在播放的歌曲。
//
// 状态驱动: jotai atom (queueDrawerState.ts)
// 基础组件: ui/Drawer (提供面板框架、动画、遮罩、键盘关闭)

import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai/react';
import { Virtuoso } from 'react-virtuoso';
import { X, Play, ListMusic } from 'lucide-react';
import { cn } from '@common/cn';
import { isSameMedia, compositeKey } from '@common/mediaKey';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useCurrentMusic, useMusicQueue } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { useMultiSelect } from '@renderer/mainWindow/hooks/useMultiSelect';
import { useRovingFocus } from '@renderer/common/hooks/useRovingFocus';
import { useMusicOnCloud } from '@renderer/mainWindow/core/cloudSource';
import { useMusicLocalFile } from '@renderer/mainWindow/core/localSource';
import { displayPlatform } from '@renderer/mainWindow/core/sourceLabel';
import Drawer from '../../ui/Drawer';
import { queueDrawerOpenAtom, closeQueueDrawer } from './queueDrawerState';
import './index.scss';
import { showContextMenu } from '../../ui/ContextMenu/contextMenuManager';
import { showToast } from '../../ui/Toast';
import { PLAY_QUEUE_SHEET_ID } from '@infra/musicSheet/common/constant';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const ITEM_HEIGHT = 48;

// ────────────────────────────────────────────────────────────────────────────
// QueueItemRow (memoized)
// ────────────────────────────────────────────────────────────────────────────

interface QueueItemRowProps {
    item: IMusicItemSlim;
    index: number;
    isActive: boolean;
    selected: boolean;
    onPlay: (index: number) => void;
    onRemove: (item: IMusicItemSlim) => void;
    onRowClick: (index: number, item: IMusicItemSlim, e: React.MouseEvent) => void;
    onContextMenu: (item: IMusicItemSlim, index: number, e: React.MouseEvent) => void;
    /** 行挂载时自注册进焦点组（虚拟滚动） */
    registerRow: (el: HTMLElement | null) => void;
}

const QueueItemRow = React.memo(function QueueItemRow({
    item,
    index,
    isActive,
    selected,
    onPlay,
    onRemove,
    onRowClick,
    onContextMenu,
    registerRow,
}: QueueItemRowProps) {
    const { t } = useTranslation();
    const handleDoubleClick = useCallback(() => onPlay(index), [index, onPlay]);

    /**
     * 队列行显示的是「这首歌的音源在哪」，而不是它从哪个插件搜来的：
     *   本地有文件 → 本地；云盘有 → 云端；都没有 → 插件名（播放时去插件取流）。
     * 播放队列是「接下来要放什么」的清单，所以这里按音源所在位置显示；
     * 歌单列表的「来源」列显示的是出处（插件），两者语义不同。
     *
     * 「有」一律以**真实文件**为准（本地磁盘 / 云端列表），不看下载记录与上传清单。
     */
    const hasLocalFile = useMusicLocalFile(item);
    const onCloud = useMusicOnCloud(item);
    const sourceLabel = hasLocalFile
        ? t('music_toggle.source_local')
        : onCloud
          ? t('music_toggle.source_cloud')
          : displayPlatform(item.platform, t);

    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            onContextMenu(item, index, e);
        },
        [onContextMenu, item, index],
    );

    /** 普通单击 = 选中（Ctrl 切换 / Shift 连选，语义见 core/selection）；双击播放 */
    const handleRowClick = useCallback(
        (e: React.MouseEvent) => {
            onRowClick(index, item, e);
        },
        [onRowClick, index, item],
    );

    const handleRemoveClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onRemove(item);
        },
        [onRemove, item],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPlay(index);
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                onRemove(item);
            }
        },
        [onPlay, onRemove, index, item],
    );

    return (
        <div
            ref={registerRow}
            className={cn(
                'l-queue-drawer__item',
                isActive && 'is-active',
                // 批量切源后没匹配上的：变暗，播放时交给自动换源
                item.sourceMatched === false && 'is-unmatched',
                selected && 'is-selected',
            )}
            style={{ height: ITEM_HEIGHT }}
            onClick={handleRowClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            role="option"
            data-roving-item
            aria-selected={selected || isActive}
        >
            {/* Active indicator bar */}
            {isActive && <div className="l-queue-drawer__active-bar" />}

            {/* Index / Equalizer：选中只靠整行高亮（与各列表一致，不再单独画勾选框） */}
            <div className="l-queue-drawer__item-index">
                {isActive ? (
                    <div className="l-queue-drawer__equalizer">
                        <span className="l-queue-drawer__eq-bar l-queue-drawer__eq-bar--1" />
                        <span className="l-queue-drawer__eq-bar l-queue-drawer__eq-bar--2" />
                        <span className="l-queue-drawer__eq-bar l-queue-drawer__eq-bar--3" />
                    </div>
                ) : (
                    <>
                        <span className="l-queue-drawer__item-num">{index + 1}</span>
                        <Play size={12} className="l-queue-drawer__item-play" />
                    </>
                )}
            </div>

            {/* Track info */}
            <div className="l-queue-drawer__item-info">
                <div className="l-queue-drawer__item-title">{item.title}</div>
                <div className="l-queue-drawer__item-meta">
                    <span className="l-queue-drawer__item-artist">{item.artist}</span>
                    <span className="l-queue-drawer__item-source">
                        {sourceLabel}
                        {item.sourceMatched === false && ` · ${t('playback.source_unmatched')}`}
                    </span>
                </div>
            </div>

            {/* Remove button */}
            <button
                className="l-queue-drawer__item-remove"
                onClick={handleRemoveClick}
                title={t('playback.remove_from_queue')}
                aria-label={t('playback.remove_item', { title: item.title })}
                type="button"
            >
                <X size={12} />
            </button>
        </div>
    );
});

// ────────────────────────────────────────────────────────────────────────────
// Virtuoso 自定义 List 容器（避免裸 div 选择器耐合 Virtuoso 内部 DOM）
// ────────────────────────────────────────────────────────────────────────────

const VirtuosoList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => (
        <div ref={ref} {...props} className={cn(props.className, 'l-queue-drawer__list-inner')} />
    ),
);
VirtuosoList.displayName = 'VirtuosoList';

const virtuosoComponents = { List: VirtuosoList };

// ────────────────────────────────────────────────────────────────────────────
// QueueDrawer
// ────────────────────────────────────────────────────────────────────────────

/**
 * QueueDrawer
 * @layer layout
 *
 * 右侧滑出的播放队列抽屉。
 * - 使用 Virtuoso 虚拟滚动渲染队列列表
 * - 高亮当前播放项并自动滚动到视口
 * - 支持单曲移除和清空队列操作
 */
export default function QueueDrawer() {
    const { t } = useTranslation();
    const open = useAtomValue(queueDrawerOpenAtom);
    const queue = useMusicQueue();
    const currentMusic = useCurrentMusic();

    /**
     * 多选：和其它列表同一套语义（core/selection）——
     * 普通单击单选、Ctrl/Cmd+单击切换、Shift+单击连选、Ctrl+A 全选、Esc 取消；
     * 选中只做整行高亮，批量操作（换源 / 移除）在右键菜单里。
     */
    const listRootRef = useRef<HTMLElement | null>(null);
    const getId = useCallback((item: IMusicItemSlim) => compositeKey(item.platform, item.id), []);
    const {
        selectedIds,
        handleRowClick: applyRowClick,
        resolveContextSelection,
    } = useMultiSelect<IMusicItemSlim>({
        items: queue,
        getId,
        resetDeps: [open],
        rootRef: listRootRef,
    });

    // 计算当前播放的索引
    const activeIndex = useMemo(() => {
        if (!currentMusic) return -1;
        return queue.findIndex((item) => isSameMedia(item, currentMusic));
    }, [queue, currentMusic]);

    /**
     * 队列是 role="listbox" 的竖向列表 → 焦点组（↑↓ 在行间移动）。
     * 行自己的 onKeyDown 管 Enter/Space/Delete，方向键交给这里。
     * 列表是虚拟滚动的（行随滚动增删），行的增删由钩子里的 MutationObserver 兜住。
     */
    const roving = useRovingFocus<HTMLDivElement>({
        orientation: 'vertical',
        itemCount: queue.length,
    });

    // Drawer 使用 AnimatePresence，关闭时 Virtuoso 会卸载；
    // 重新打开时 Virtuoso 重新挂载，initialTopMostItemIndex 自然生效。
    const initialTopMostItemIndex = useMemo(
        () => (activeIndex >= 0 ? { index: activeIndex, align: 'center' as const } : 0),
        [activeIndex],
    );

    // ── Handlers ──
    const handlePlay = useCallback((index: number) => {
        trackPlayer.playIndex(index);
    }, []);

    const handleRemove = useCallback((item: IMusicItemSlim) => {
        trackPlayer.removeMusic(item);
    }, []);

    const handleContextMenu = useCallback(
        (_item: IMusicItemSlim, index: number, e: React.MouseEvent) => {
            // 用统一的多选解析：右键项已在选区 → 整个选区；否则先把它变成单选
            const items = resolveContextSelection(index);
            if (!items.length) return;
            showContextMenu(
                'MusicItemMenu',
                {
                    x: e.clientX,
                    y: e.clientY,
                },
                {
                    musicItems: items as unknown as IMusic.IMusicItem[],
                    sheetId: PLAY_QUEUE_SHEET_ID,
                },
            );
        },
        [resolveContextSelection],
    );

    /** 行点击（Ctrl 切换 / Shift 连选 / 普通单选） */
    const handleRowClick = useCallback(
        (index: number, _item: IMusicItemSlim, e: React.MouseEvent) => {
            applyRowClick(index, e);
        },
        [applyRowClick],
    );

    const handleClear = useCallback(() => {
        trackPlayer.reset();
    }, []);

    /** 队列里有没有「被切到本地/云盘」的歌（有才显示「还原来源」） */
    const hasSwitchedItems = useMemo(() => queue.some((item) => !!item.originPlatform), [queue]);

    /** 一次性把所有切换过的歌还原回原始来源 */
    const handleRestoreAllSources = useCallback(() => {
        const restored = trackPlayer.restoreAllQueueSources();
        if (restored > 0) {
            showToast(t('playback.restore_queue_source_done', { count: restored }));
        }
    }, [t]);

    // ── Virtuoso: itemContent ──
    const itemContent = useCallback(
        (index: number, item: IMusicItemSlim) => (
            <QueueItemRow
                item={item}
                index={index}
                isActive={index === activeIndex}
                selected={selectedIds.has(compositeKey(item.platform, item.id))}
                onPlay={handlePlay}
                onRemove={handleRemove}
                onRowClick={handleRowClick}
                onContextMenu={handleContextMenu}
                // 行挂载时自注册进焦点组（虚拟滚动，行是 Virtuoso 自己插进来的）
                registerRow={roving.registerItem}
            />
        ),
        [
            activeIndex,
            selectedIds,
            handlePlay,
            handleRemove,
            handleRowClick,
            handleContextMenu,
            roving.registerItem,
        ],
    );

    // ── Header（覆盖 Drawer 默认 header） ──
    const header = useMemo(
        () => (
            <div className="l-queue-drawer__header">
                <div className="l-queue-drawer__header-row">
                    <div className="l-queue-drawer__header-left">
                        <h3 className="l-queue-drawer__title">{t('playback.queue_title')}</h3>
                        {queue.length > 0 && (
                            <span className="l-queue-drawer__count">
                                {t('playback.queue_count', { count: queue.length })}
                            </span>
                        )}
                    </div>
                    <div className="l-queue-drawer__header-right">
                        {hasSwitchedItems && (
                            <button
                                className="l-queue-drawer__clear-btn"
                                onClick={handleRestoreAllSources}
                                type="button"
                                title={t('playback.restore_queue_source_desc')}
                            >
                                {t('playback.restore_queue_source')}
                            </button>
                        )}
                        <button
                            className="l-queue-drawer__clear-btn"
                            onClick={handleClear}
                            type="button"
                            title={t('playback.clear_queue')}
                        >
                            {t('playback.clear_queue')}
                        </button>
                        <button
                            className="l-queue-drawer__close-btn"
                            onClick={closeQueueDrawer}
                            type="button"
                            aria-label={t('playback.close_queue')}
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            </div>
        ),
        [queue.length, hasSwitchedItems, handleRestoreAllSources, handleClear, t],
    );

    return (
        <Drawer
            open={open}
            onClose={closeQueueDrawer}
            closable={false}
            showOverlay={false}
            closeOnClickOutside
            className="l-queue-drawer"
        >
            {/* Custom header — Drawer closable=false, 我们自己画 header */}
            {header}

            {/* Divider */}
            <div className="l-queue-drawer__divider" />

            {/* Body */}
            {queue.length === 0 ? (
                <div className="l-queue-drawer__empty">
                    <ListMusic size={48} strokeWidth={1.5} className="l-queue-drawer__empty-icon" />
                    <div className="l-queue-drawer__empty-title">
                        {t('playback.queue_empty_title')}
                    </div>
                    <div className="l-queue-drawer__empty-desc">
                        {t('playback.queue_empty_desc')}
                    </div>
                </div>
            ) : (
                // 焦点组的容器：`display: contents` 不产生盒子，纯粹为了拿到
                // 「行 → 列表」的事件冒泡与 querySelectorAll 作用域，布局不受影响。
                <div {...roving.containerProps} style={{ display: 'contents' }}>
                    <Virtuoso
                        data={queue}
                        initialTopMostItemIndex={initialTopMostItemIndex}
                        fixedItemHeight={ITEM_HEIGHT}
                        itemContent={itemContent}
                        components={virtuosoComponents}
                        className="l-queue-drawer__list"
                        role="listbox"
                        aria-label={t('playback.queue_list_label')}
                        // 滚动容器就是队列行的根：多选快捷键只作用于「刚点过的列表」
                        scrollerRef={(el) => {
                            listRootRef.current = (el as HTMLElement | null) ?? null;
                        }}
                    />
                </div>
            )}
        </Drawer>
    );
}
