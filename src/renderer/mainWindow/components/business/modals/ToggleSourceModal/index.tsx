import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ArrowRight, HardDrive, Cloud } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { ScrollArea } from '@renderer/mainWindow/components/ui/ScrollArea';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import TabBar from '@renderer/mainWindow/components/ui/TabBar';
import { Artwork } from '@renderer/mainWindow/components/ui/Artwork';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import pluginManager from '@infra/pluginManager/renderer';
import { usePluginMeta } from '@infra/pluginManager/renderer/hooks';
import { sortByPluginOrder } from '@infra/pluginManager/common/sortByOrder';
import { useMusicLocalPath } from '@renderer/mainWindow/core/localSource';
import cloudSource, { useCloudSourceReady } from '@renderer/mainWindow/core/cloudSource';
import { usePluginContextMenu } from '@renderer/mainWindow/hooks/usePluginContextMenu';
import { usePluginTagReorder } from '@renderer/mainWindow/hooks/usePluginTagReorder';
import {
    buildSearchKeyword,
    mapWithConcurrency,
    pickMatchMusic,
    TOGGLE_SEARCH_CONCURRENCY,
} from '@renderer/mainWindow/core/sourceMatch';
import { displayPlatform } from '@renderer/mainWindow/core/sourceLabel';
import { CLOUD_PLUGIN_NAME, LOCAL_PLUGIN_NAME, RequestStatus } from '@common/constant';
import { cn } from '@common/cn';
import formatDuration from '@common/formatDuration';
import './index.scss';

export interface ToggleSourceModalProps {
    close: () => void;
    /** 待换源的原始歌曲 */
    musicItem: IMusic.IMusicItem;
    /** 确认换源：由调用方决定把结果写回哪个列表 */
    onConfirm: (newItem: IMusic.IMusicItem) => void | Promise<void>;
}

/** 单个插件的搜索结果 */
interface PluginSearchResult {
    loading: boolean;
    /** 该插件全部搜索结果 */
    data: IMusic.IMusicItem[];
    /** 按换源匹配规则命中的歌曲（默认选中项） */
    match: IMusic.IMusicItem | null;
    error?: boolean;
}

/**
 * ToggleSourceModal — 单曲换源弹窗
 *
 * 通过 showModal('ToggleSourceModal', { musicItem, onConfirm }) 命令式打开。
 *
 * 换源顺序与取源链一致：**本地文件 → 云盘 → 插件**。
 * 所以搜索栏下面第一、二行就是本地与云盘（不可用时置灰说明原因），
 * 插件的搜索结果排在它们后面；并行搜索所有支持搜索的插件，
 * 按「换源匹配规则」预选出最佳匹配，用户也可手动挑选其它版本。
 *
 * 插件 Tab 支持长按拖动排序，右键可禁用/更新/卸载插件。
 */
export default function ToggleSourceModal({ close, musicItem, onConfirm }: ToggleSourceModalProps) {
    const { t } = useTranslation();

    const defaultQuery = buildSearchKeyword(musicItem);
    const [query, setQuery] = useState(defaultQuery);

    // 可用于换源的插件（支持 search 且已启用）。
    // 订阅 meta 以保证长按排序 / 右键禁用后列表能实时重排或移除。
    const pluginMeta = usePluginMeta();
    const plugins = useMemo(
        () => sortByPluginOrder(pluginManager.getSearchablePlugins('music'), pluginMeta),
        [pluginMeta],
    );

    /** 用户手动选中的插件 Tab（空表示尚未选择） */
    const [activePluginKeyState, setActivePluginKey] = useState('');

    /** 实际生效的插件 Tab：被禁用/移除后自动回退到第一个可用插件 */
    const activePluginKey = useMemo(() => {
        if (activePluginKeyState && plugins.some((p) => p.hash === activePluginKeyState)) {
            return activePluginKeyState;
        }
        return plugins[0]?.hash ?? '';
    }, [activePluginKeyState, plugins]);

    /** 每个插件的搜索结果 */
    const [results, setResults] = useState<Record<string, PluginSearchResult>>({});

    /** 用户选中的换源目标；未手动选择时跟随当前 Tab 的最佳匹配 */
    const [selected, setSelected] = useState<IMusic.IMusicItem | null>(null);
    const [applying, setApplying] = useState(false);

    /**
     * 选中的「本地文件 / 云盘」快捷项（null = 用插件搜索结果）。
     *
     * 不再用「插件/本地/云盘」三个来源按钮切换：本地与云盘就是列表最上面两行，
     * 换源顺序天然是 本地 → 云端 → 插件（插件结果在下面）。
     */
    const [pickedSource, setPickedSource] = useState<'local' | 'cloud' | null>(null);

    /**
     * 本地文件路径（null = 本地没有文件）。
     * 以**文件系统**为准：下载记录还在但文件被删掉时，这里不给「切到本地」。
     * 含「切到本地」后被改写 platform 的情况（走 originPlatform/originId 反查）。
     */
    const localPath = useMusicLocalPath(
        musicItem as IMusic.IMusicItem & { originPlatform?: string; originId?: string },
    );

    /** 当前本来就是本地/云盘条目 → 对应项没有换的意义 */
    const isLocalItem = musicItem.platform === LOCAL_PLUGIN_NAME;
    const isCloudItem = musicItem.platform === CLOUD_PLUGIN_NAME;

    /**
     * 云盘里同名的那个文件（null = 没有）。
     * 直接查 cloudSource 的真实远端列表索引（60s 缓存，不会每次打网络）；
     * 列表还没读到时显示「检查中」。
     */
    const cloudReady = useCloudSourceReady();
    const cloudChecking = !isCloudItem && !cloudReady;
    const cloudMatch = isCloudItem || cloudChecking ? null : cloudSource.getRemoteItem(musicItem);

    const localAvailable = !isLocalItem && localPath !== null;
    const cloudAvailable = !isCloudItem && !!cloudMatch;

    const localReason = isLocalItem
        ? t('music_toggle.already_local')
        : localPath === null
          ? t('music_toggle.local_unavailable')
          : '';
    const cloudReason = isCloudItem
        ? t('music_toggle.already_cloud')
        : cloudChecking
          ? t('music_toggle.cloud_checking')
          : !cloudMatch
            ? t('music_toggle.cloud_unavailable')
            : '';

    /** 「切到本地」的目标：platform 记为本地，原始身份留在 originPlatform / originId */
    const localTarget = useMemo((): IMusic.IMusicItem | null => {
        if (!localAvailable) return null;
        return {
            ...musicItem,
            platform: LOCAL_PLUGIN_NAME,
            originPlatform: musicItem.platform,
            originId: String(musicItem.id),
            sourceMatched: true,
        } as unknown as IMusic.IMusicItem;
    }, [localAvailable, musicItem]);

    /** 「切到云盘」的目标：id 用云盘上的远端路径（云盘插件按它取流） */
    const cloudTarget = useMemo((): IMusic.IMusicItem | null => {
        if (!cloudAvailable || !cloudMatch) return null;
        return {
            ...musicItem,
            platform: CLOUD_PLUGIN_NAME,
            id: cloudMatch.id,
            duration: cloudMatch.duration ?? musicItem.duration,
            originPlatform: musicItem.platform,
            originId: String(musicItem.id),
            sourceMatched: true,
        } as unknown as IMusic.IMusicItem;
    }, [cloudAvailable, cloudMatch, musicItem]);

    // 防止过时响应覆盖新搜索
    const searchIdRef = useRef(0);

    const tabItems = useMemo(
        () => plugins.map((p) => ({ key: p.hash, label: p.platform })),
        [plugins],
    );

    // 右键插件 Tab → 禁用/启用、更新、卸载
    const handleTabContextMenu = usePluginContextMenu(plugins);

    // 长按拖动排序
    const reorderPlugins = usePluginTagReorder();
    const visibleHashes = useMemo(() => plugins.map((p) => p.hash), [plugins]);
    const handleSortEnd = useCallback(
        (fromIndex: number, toIndex: number) => {
            reorderPlugins(visibleHashes, fromIndex, toIndex);
        },
        [reorderPlugins, visibleHashes],
    );

    /** 执行搜索 */
    const doSearch = useCallback(
        (searchQuery: string) => {
            const keyword = searchQuery.trim();
            if (!keyword || plugins.length === 0) return;

            const searchId = ++searchIdRef.current;

            const initial: Record<string, PluginSearchResult> = {};
            for (const plugin of plugins) {
                initial[plugin.hash] = { loading: true, data: [], match: null };
            }
            setResults(initial);
            setSelected(null);

            // 受限并发：同时只向少量插件发起搜索，避免主进程被请求风暴拖垮
            void mapWithConcurrency(plugins, TOGGLE_SEARCH_CONCURRENCY, async (plugin) => {
                try {
                    const result = await pluginManager.callPluginMethod({
                        hash: plugin.hash,
                        method: 'search',
                        args: [keyword, 1, 'music'],
                    });
                    if (searchIdRef.current !== searchId) return;
                    const data = (result?.data as IMusic.IMusicItem[]) ?? [];
                    setResults((prev) => ({
                        ...prev,
                        [plugin.hash]: {
                            loading: false,
                            data,
                            match: pickMatchMusic(musicItem, data),
                        },
                    }));
                } catch {
                    if (searchIdRef.current !== searchId) return;
                    setResults((prev) => ({
                        ...prev,
                        [plugin.hash]: {
                            loading: false,
                            data: [],
                            match: null,
                            error: true,
                        },
                    }));
                }
            });
        },
        [plugins, musicItem],
    );

    // 打开时自动搜索一次
    const initialSearchDone = useRef(false);
    useEffect(() => {
        if (!initialSearchDone.current && defaultQuery) {
            initialSearchDone.current = true;
            doSearch(defaultQuery);
        }
    }, [defaultQuery, doSearch]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') doSearch(query);
        },
        [doSearch, query],
    );

    const activeResult = results[activePluginKey];

    /** 当前生效的换源目标：本地/云盘快捷项优先，其次插件 Tab 的匹配结果 */
    const effectiveSelected = useMemo(() => {
        if (pickedSource === 'local') return localTarget;
        if (pickedSource === 'cloud') return cloudTarget;
        if (selected) return selected;
        return activeResult?.match ?? null;
    }, [pickedSource, localTarget, cloudTarget, selected, activeResult]);

    /** 已选中的插件 Tab（用于标记） */
    const matchedPluginKey = useMemo(() => {
        if (!effectiveSelected) return '';
        const found = plugins.find((p) => p.platform === effectiveSelected.platform);
        return found?.hash ?? '';
    }, [effectiveSelected, plugins]);

    const handleConfirm = useCallback(async () => {
        if (!effectiveSelected || applying) return;
        setApplying(true);
        try {
            await onConfirm(effectiveSelected);
            close();
        } finally {
            setApplying(false);
        }
    }, [effectiveSelected, applying, onConfirm, close]);

    const resultStatus = !activeResult
        ? RequestStatus.Idle
        : activeResult.loading
          ? RequestStatus.Pending
          : activeResult.error
            ? RequestStatus.Error
            : RequestStatus.Done;

    const sourceLabel = `${displayPlatform(musicItem.platform, t)} · ${formatDuration(musicItem.duration)}`;
    const targetLabel = effectiveSelected
        ? `${displayPlatform(effectiveSelected.platform, t)} · ${formatDuration(effectiveSelected.duration)}`
        : '';

    return (
        <Modal
            open
            onClose={close}
            title={t('music_toggle.title')}
            subtitle={t('music_toggle.subtitle')}
            size="lg"
            footer={
                <>
                    <Button variant="secondary" onClick={close} disabled={applying}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleConfirm}
                        disabled={!effectiveSelected}
                        loading={applying}
                    >
                        {t('music_toggle.confirm')}
                    </Button>
                </>
            }
        >
            <div className="b-toggle-source-modal">
                {/* 原曲 → 目标曲 对照 */}
                <div className="b-toggle-source-modal__compare">
                    <div className="b-toggle-source-modal__compare-item">
                        <div className="b-toggle-source-modal__compare-title">
                            {musicItem.title}
                        </div>
                        <div className="b-toggle-source-modal__compare-meta">
                            {musicItem.artist}
                            <span className="b-toggle-source-modal__compare-source">
                                {sourceLabel}
                            </span>
                        </div>
                    </div>

                    {effectiveSelected && (
                        <>
                            <ArrowRight
                                size={16}
                                className="b-toggle-source-modal__compare-arrow"
                            />
                            <div className="b-toggle-source-modal__compare-item">
                                <div className="b-toggle-source-modal__compare-title">
                                    {effectiveSelected.title}
                                </div>
                                <div className="b-toggle-source-modal__compare-meta">
                                    {effectiveSelected.artist}
                                    <span className="b-toggle-source-modal__compare-source">
                                        {targetLabel}
                                    </span>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* 搜索栏 */}
                <div className="b-toggle-source-modal__search-bar">
                    <Input
                        prefix={<Search size={16} />}
                        placeholder={t('music_toggle.search_placeholder')}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        allowClear
                        onClear={() => setQuery('')}
                    />
                </div>

                {/* 本地 / 云盘：换源顺序的第一、二级，直接放在搜索栏下面。
                    不可用时置灰并写明原因（未下载 / 云盘没有同名文件）。 */}
                <div className="b-toggle-source-modal__sources">
                    {(
                        [
                            {
                                key: 'local' as const,
                                label: t('music_toggle.source_local'),
                                icon: <HardDrive size={15} />,
                                target: localTarget,
                                disabled: !localAvailable,
                                hint: localAvailable
                                    ? (localPath ?? '')
                                    : localReason || t('music_toggle.local_unavailable'),
                            },
                            {
                                key: 'cloud' as const,
                                label: t('music_toggle.source_cloud'),
                                icon: <Cloud size={15} />,
                                target: cloudTarget,
                                disabled: !cloudAvailable,
                                // 云盘条目的 id 是服务端存的映射名（带 hash 与 .zip），
                                // 展示用解析出来的「歌名 - 歌手」更可读
                                hint: cloudAvailable
                                    ? [cloudMatch?.title, cloudMatch?.artist]
                                          .filter(Boolean)
                                          .join(' - ') ||
                                      (cloudMatch?.id ?? '')
                                    : cloudReason || t('music_toggle.cloud_unavailable'),
                            },
                        ] as const
                    ).map((it) => (
                        <button
                            key={it.key}
                            type="button"
                            className={cn(
                                'b-toggle-source-modal__source',
                                pickedSource === it.key && 'is-selected',
                            )}
                            disabled={it.disabled || applying}
                            onClick={() => {
                                setPickedSource(it.key);
                                setSelected(null);
                            }}
                        >
                            <span className="b-toggle-source-modal__source-icon">{it.icon}</span>
                            <span className="b-toggle-source-modal__source-info">
                                <span className="b-toggle-source-modal__source-label">
                                    {it.label}
                                </span>
                                <span
                                    className="b-toggle-source-modal__source-hint"
                                    title={it.hint}
                                >
                                    {it.hint}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>

                {/* 插件 Tab */}
                {plugins.length > 0 && (
                    <TabBar
                        items={tabItems.map((item) => ({
                            ...item,
                            label: item.key === matchedPluginKey ? `${item.label} ✓` : item.label,
                        }))}
                        activeKey={activePluginKey}
                        onChange={(hash) => {
                            setPickedSource(null);
                            setActivePluginKey(hash);
                        }}
                        onTabContextMenu={handleTabContextMenu}
                        enableDragSort
                        onSortEnd={handleSortEnd}
                        dragSortHint={t('plugin.long_press_sort')}
                        className="b-toggle-source-modal__tabs"
                    />
                )}

                {/* 插件搜索结果（本地 / 云盘已在上面的两行里，不用再占列表） */}
                <ScrollArea className="b-toggle-source-modal__results">
                    {plugins.length === 0 ? (
                        <StatusPlaceholder
                            status={RequestStatus.Done}
                            isEmpty
                            emptyTitle={t('music_toggle.no_plugin')}
                        />
                    ) : (
                        <>
                            <StatusPlaceholder
                                status={resultStatus}
                                isEmpty={activeResult?.data.length === 0}
                                emptyTitle={t('music_toggle.no_result')}
                                errorTitle={t('music_toggle.search_failed')}
                                onRetry={() => doSearch(query)}
                            />
                            {resultStatus === RequestStatus.Done &&
                                (activeResult?.data ?? []).map((item, index) => {
                                    const isSelected =
                                        pickedSource === null &&
                                        effectiveSelected?.platform === item.platform &&
                                        String(effectiveSelected?.id) === String(item.id);
                                    return (
                                        <button
                                            key={`${item.platform}-${item.id}-${index}`}
                                            type="button"
                                            className={cn(
                                                'b-toggle-source-modal__item',
                                                isSelected && 'is-selected',
                                            )}
                                            disabled={applying}
                                            onClick={() => {
                                                setPickedSource(null);
                                                setSelected(item);
                                            }}
                                        >
                                            <Artwork
                                                src={item.artwork}
                                                size="sm"
                                                rounded="sm"
                                                coverKind="song"
                                            />
                                            <div className="b-toggle-source-modal__item-info">
                                                <div className="b-toggle-source-modal__item-title">
                                                    {item.title}
                                                </div>
                                                <div className="b-toggle-source-modal__item-artist">
                                                    {item.artist}
                                                    {item.album ? ` · ${item.album}` : ''}
                                                </div>
                                            </div>
                                            <span className="b-toggle-source-modal__item-duration">
                                                {formatDuration(item.duration)}
                                            </span>
                                        </button>
                                    );
                                })}
                        </>
                    )}
                </ScrollArea>
            </div>
        </Modal>
    );
}
