import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Cloud, HardDrive, Plug } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { ScrollArea } from '@renderer/mainWindow/components/ui/ScrollArea';
import TabBar from '@renderer/mainWindow/components/ui/TabBar';
import { Artwork } from '@renderer/mainWindow/components/ui/Artwork';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import { Badge } from '@renderer/mainWindow/components/ui/Badge';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { cn } from '@common/cn';
import { useCurrentMusic } from '@renderer/mainWindow/core/trackPlayer/hooks';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import pluginManager from '@infra/pluginManager/renderer';
import { useSortedSearchablePlugins } from '@infra/pluginManager/renderer/hooks';
import mediaMeta from '@infra/mediaMeta/renderer';
import localMusic from '@infra/localMusic/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import { usePluginContextMenu } from '@renderer/mainWindow/hooks/usePluginContextMenu';
import { usePluginTagReorder } from '@renderer/mainWindow/hooks/usePluginTagReorder';
import { RequestStatus } from '@common/constant';
import type { ILocalLyricItem } from '@appTypes/infra/localMusic';
import type { ICloudLyricFile } from '@appTypes/infra/cloudDisk';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import './index.scss';

interface SearchLyricModalProps {
    /**
     * 关联目标歌曲。
     *
     * 不传 = 当前播放的歌（播放器入口的原有行为）；
     * 传了 = 给指定歌曲关联歌词（「歌词管理」里从列表点某一行进来时用），
     * 这时不去刷新播放器正在显示的那份歌词。
     */
    musicItem?: IMusic.IMusicItem | IMusicItemSlim;
    close: () => void;
}

/** 单个插件的搜索结果 */
interface PluginSearchResult {
    loading: boolean;
    data: ILyric.ILyricItem[];
    error?: boolean;
}

/** 歌词来源：插件 / 本地扫描到的 .lrc / 云盘歌词目录 */
type LyricOrigin = 'plugin' | 'local' | 'cloud';

/** 把 fs 读到的内容统一成字符串 */
function toText(content: string | Buffer): string {
    return typeof content === 'string'
        ? content
        : new TextDecoder().decode(content as unknown as ArrayBuffer);
}

/** 关键词匹配：空格分隔的每个词都要命中（歌名 / 歌手 / 文件名） */
function matchTokens(haystack: string, query: string): boolean {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = haystack.toLowerCase();
    return tokens.every((tk) => hay.includes(tk));
}

/**
 * SearchLyricModal — 搜索歌词业务弹窗
 *
 * 通过 showModal('SearchLyricModal') 命令式打开。
 * 三类来源：
 *   - 插件：搜索所有支持 lyric 搜索类型的插件
 *   - 本地文件：本地音乐扫描目录里扫到的 .lrc（含「孤儿歌词」）
 *   - 云盘：/MusicFree/lyrics 下的 .lrc
 * 点击任意结果都会写入手动关联并立即刷新歌词。
 */
export default function SearchLyricModal({ musicItem, close }: SearchLyricModalProps) {
    const { t } = useTranslation();
    const currentMusic = useCurrentMusic();

    /**
     * 本次要关联到哪首歌：显式传入的优先（歌词管理里按行进来），否则用当前播放的歌。
     * 「是不是在给正在播的这首歌关联」决定要不要刷新播放器的歌词显示。
     */
    const targetMusic = musicItem ?? currentMusic;
    const targetsCurrent =
        !!currentMusic &&
        !!targetMusic &&
        currentMusic.platform === targetMusic.platform &&
        String(currentMusic.id) === String(targetMusic.id);

    // 搜索关键词，默认预填目标歌曲 title + artist
    const defaultQuery = targetMusic
        ? `${targetMusic.title ?? ''}${targetMusic.artist ? ` ${targetMusic.artist}` : ''}`
        : '';
    const [query, setQuery] = useState(defaultQuery);

    /** 当前来源 */
    const [origin, setOrigin] = useState<LyricOrigin>('plugin');

    // 插件列表：与排行榜 / 热门歌单 / 歌曲搜索一致，
    // 用 useSortedSearchablePlugins 订阅插件状态 —— 禁用/启用、排序变化会立即反映到标签栏
    const plugins = useSortedSearchablePlugins('lyric');

    // 当前选中的插件 Tab（选中的插件被禁用/卸载后自动回退到第一个）
    const [activeHash, setActiveHash] = useState('');
    const activePluginKey = useMemo(() => {
        if (activeHash && plugins.some((p) => p.hash === activeHash)) return activeHash;
        return plugins[0]?.hash ?? '';
    }, [activeHash, plugins]);

    // 每个插件的搜索结果
    const [results, setResults] = useState<Record<string, PluginSearchResult>>({});

    // 关联中状态
    const [linking, setLinking] = useState(false);

    // 本地歌词文件池 / 云盘歌词文件列表（切到对应来源时惰性加载一次）
    const [localLyrics, setLocalLyrics] = useState<ILocalLyricItem[] | null>(null);
    const [cloudLyrics, setCloudLyrics] = useState<ICloudLyricFile[] | null>(null);
    const [fileListLoading, setFileListLoading] = useState(false);

    // 防止过时响应覆盖新搜索
    const searchIdRef = useRef(0);

    const tabItems = useMemo(
        () => plugins.map((p) => ({ key: p.hash, label: p.platform })),
        [plugins],
    );

    // 右键插件标签 → 禁用/启用、更新、卸载
    const handleTabContextMenu = usePluginContextMenu(plugins);

    // 长按拖动排序：把本页可见插件的槽位按新顺序回填到全局顺序中
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
            if (!searchQuery.trim() || plugins.length === 0) return;

            const searchId = ++searchIdRef.current;

            // 所有插件置为 loading
            const initialResults: Record<string, PluginSearchResult> = {};
            for (const plugin of plugins) {
                initialResults[plugin.hash] = { loading: true, data: [] };
            }
            setResults(initialResults);

            // 并行搜索所有插件
            for (const plugin of plugins) {
                pluginManager
                    .callPluginMethod({
                        hash: plugin.hash,
                        method: 'search',
                        args: [searchQuery.trim(), 1, 'lyric'],
                    })
                    .then((result) => {
                        if (searchIdRef.current !== searchId) return;
                        setResults((prev) => ({
                            ...prev,
                            [plugin.hash]: {
                                loading: false,
                                data: (result?.data as ILyric.ILyricItem[]) ?? [],
                            },
                        }));
                    })
                    .catch(() => {
                        if (searchIdRef.current !== searchId) return;
                        setResults((prev) => ({
                            ...prev,
                            [plugin.hash]: { loading: false, data: [], error: true },
                        }));
                    });
            }
        },
        [plugins],
    );

    // 打开时自动搜索
    const initialSearchDone = useRef(false);
    useEffect(() => {
        if (!initialSearchDone.current && defaultQuery) {
            initialSearchDone.current = true;
            doSearch(defaultQuery);
        }
    }, [defaultQuery, doSearch]);

    // ─── 本地 / 云盘歌词列表（切过去才拉，避免无谓 IPC） ───
    useEffect(() => {
        if (origin !== 'local' || localLyrics !== null) return;
        setFileListLoading(true);
        localMusic
            .getAllLocalLyrics()
            .then((list) => setLocalLyrics(list))
            .catch(() => setLocalLyrics([]))
            .finally(() => setFileListLoading(false));
    }, [origin, localLyrics]);

    useEffect(() => {
        if (origin !== 'cloud' || cloudLyrics !== null) return;
        setFileListLoading(true);
        cloudDisk
            .listLyricFiles()
            .then((list) => setCloudLyrics(list))
            .catch(() => setCloudLyrics([]))
            .finally(() => setFileListLoading(false));
    }, [origin, cloudLyrics]);

    /** 按关键词过滤本地歌词文件 */
    const filteredLocal = useMemo(() => {
        if (!localLyrics) return [];
        return localLyrics.filter((it) =>
            matchTokens(`${it.title} ${it.artist} ${it.fileName}`, query),
        );
    }, [localLyrics, query]);

    /** 按关键词过滤云盘歌词文件 */
    const filteredCloud = useMemo(() => {
        if (!cloudLyrics) return [];
        return cloudLyrics.filter((it) =>
            matchTokens(`${it.title} ${it.artist} ${it.name}`, query),
        );
    }, [cloudLyrics, query]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
                doSearch(query);
            }
        },
        [doSearch, query],
    );

    /** 把手动选中的歌词文本写进 mediaMeta 并刷新 */
    const applyManualLyric = useCallback(
        async (lyricItem: ILyric.ILyricItem, rawLrc: string, translation?: string) => {
            if (!targetMusic) return;

            await mediaMeta.setMeta(
                targetMusic.platform,
                String(targetMusic.id),
                {
                    associatedLyric: {
                        // 用户手动关联 → 歌词取源链里永远第一优先
                        source: 'manual' as const,
                        musicItem: lyricItem,
                        rawLrc,
                        translation,
                    },
                },
                // 作品键：换插件播同一首歌也要认这份关联
                { title: targetMusic.title, artist: targetMusic.artist },
            );

            // 只有给「正在播放的这首歌」关联时才刷新播放器里的歌词
            if (targetsCurrent) await trackPlayer.refreshLyric();
            showToast(t('lyric.link_success'));
            close();
        },
        [targetMusic, targetsCurrent, close, t],
    );

    /** 点击插件搜索结果，关联歌词 */
    const handleSelectLyric = useCallback(
        async (lyricItem: ILyric.ILyricItem) => {
            if (!targetMusic || linking) return;

            setLinking(true);
            try {
                // 调用插件 getLyric 获取歌词文本
                const lyricSource = await pluginManager.callPluginMethod({
                    platform: lyricItem.platform,
                    method: 'getLyric',
                    args: [lyricItem],
                });

                if (!lyricSource?.rawLrc && !lyricSource?.translation) {
                    showToast(t('lyric.no_content'), { type: 'warn' });
                    return;
                }

                const rawLrc = lyricSource.rawLrc ?? lyricSource.translation;
                const translation = lyricSource.rawLrc ? lyricSource.translation : undefined;
                await applyManualLyric(lyricItem, rawLrc, translation);
            } catch {
                showToast(t('lyric.link_failed'), { type: 'warn' });
            } finally {
                setLinking(false);
            }
        },
        [targetMusic, linking, applyManualLyric, t],
    );

    /**
     * 点击本地歌词文件，关联歌词。
     *
     * 同名 `<名>-tr.lrc` 存在时一并作为翻译关联。
     */
    const handleSelectLocal = useCallback(
        async (item: ILocalLyricItem) => {
            if (!targetMusic || linking) return;

            setLinking(true);
            try {
                const rawLrc = toText(await fsUtil.readFile(item.filePath, 'utf-8'));
                if (!rawLrc.trim()) {
                    showToast(t('lyric.no_content'), { type: 'warn' });
                    return;
                }

                // 翻译文件（<名>-tr.lrc）存在就一起带上
                let translation: string | undefined;
                const trPath = item.filePath.replace(/\.lrc$/i, '-tr.lrc');
                if (await fsUtil.isFile(trPath)) {
                    const tr = toText(await fsUtil.readFile(trPath, 'utf-8'));
                    if (tr.trim()) translation = tr;
                }

                await applyManualLyric(
                    {
                        platform: t('lyric.source_local'),
                        id: item.filePath,
                        title: item.title,
                        artist: item.artist,
                    } as ILyric.ILyricItem,
                    rawLrc,
                    translation,
                );
            } catch {
                showToast(t('lyric.link_failed'), { type: 'warn' });
            } finally {
                setLinking(false);
            }
        },
        [targetMusic, linking, applyManualLyric, t],
    );

    /** 点击云盘歌词文件，关联歌词 */
    const handleSelectCloud = useCallback(
        async (item: ICloudLyricFile) => {
            if (!targetMusic || linking) return;

            setLinking(true);
            try {
                const rawLrc = await cloudDisk.getLyricText(item.name);
                if (!rawLrc?.trim()) {
                    showToast(t('lyric.no_content'), { type: 'warn' });
                    return;
                }

                await applyManualLyric(
                    {
                        platform: t('lyric.source_cloud'),
                        id: item.remotePath,
                        title: item.title,
                        artist: item.artist,
                    } as ILyric.ILyricItem,
                    rawLrc,
                );
            } catch {
                showToast(t('lyric.link_failed'), { type: 'warn' });
            } finally {
                setLinking(false);
            }
        },
        [targetMusic, linking, applyManualLyric, t],
    );

    const activeResult = results[activePluginKey];

    // 将插件搜索状态映射为 RequestStatus
    const resultStatus = !activeResult
        ? RequestStatus.Idle
        : activeResult.loading
          ? RequestStatus.Pending
          : activeResult.error
            ? RequestStatus.Error
            : RequestStatus.Done;

    const originItems: Array<{ key: LyricOrigin; label: string; icon: React.ReactNode }> = [
        { key: 'plugin', label: t('lyric.source_plugin'), icon: <Plug size={14} /> },
        { key: 'local', label: t('lyric.source_local'), icon: <HardDrive size={14} /> },
        { key: 'cloud', label: t('lyric.source_cloud'), icon: <Cloud size={14} /> },
    ];

    return (
        <Modal open onClose={close} title={t('lyric.search')} size="lg">
            <div className="b-search-lyric-modal">
                {/* 搜索栏 */}
                <div className="b-search-lyric-modal__search-bar">
                    <Input
                        prefix={<Search size={16} />}
                        placeholder={t('lyric.search_placeholder')}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        allowClear
                        onClear={() => setQuery('')}
                        autoFocus
                    />
                </div>

                {/* 歌词来源：插件 / 本地文件 / 云盘 */}
                <div className="b-search-lyric-modal__origins">
                    {originItems.map((it) => (
                        <button
                            key={it.key}
                            type="button"
                            className={cn(
                                'b-search-lyric-modal__origin',
                                origin === it.key && 'is-active',
                            )}
                            onClick={() => setOrigin(it.key)}
                        >
                            {it.icon}
                            {it.label}
                        </button>
                    ))}
                </div>

                {/* 插件来源才有插件 Tab（长按拖动排序，右键可禁用/更新/卸载）
                    用换行模式（同排行榜/搜索页）：歌词插件往往十几个，
                    scroll 模式在窄弹窗里会把后半截标签推到视口外、点不到 */}
                {origin === 'plugin' && plugins.length > 0 && (
                    <TabBar
                        items={tabItems}
                        activeKey={activePluginKey}
                        onChange={setActiveHash}
                        onTabContextMenu={handleTabContextMenu}
                        enableDragSort
                        onSortEnd={handleSortEnd}
                        dragSortHint={t('plugin.long_press_sort')}
                        className="b-search-lyric-modal__tabs"
                    />
                )}

                {/* 搜索结果 */}
                <ScrollArea className="b-search-lyric-modal__results">
                    {origin === 'plugin' &&
                        (plugins.length === 0 ? (
                            <StatusPlaceholder
                                status={RequestStatus.Done}
                                isEmpty
                                emptyTitle={t('lyric.no_lyric_plugin')}
                            />
                        ) : (
                            <>
                                <StatusPlaceholder
                                    status={resultStatus}
                                    isEmpty={activeResult?.data.length === 0}
                                    emptyTitle={t('lyric.no_result')}
                                    errorTitle={t('lyric.search_failed')}
                                    onRetry={() => doSearch(query)}
                                />
                                {resultStatus === RequestStatus.Done &&
                                    (activeResult?.data ?? []).map((item, index) => (
                                        <button
                                            key={`${item.platform}-${item.id}-${index}`}
                                            type="button"
                                            className="b-search-lyric-modal__item"
                                            disabled={linking}
                                            onClick={() => handleSelectLyric(item)}
                                        >
                                            <Artwork
                                                src={item.artwork}
                                                size="sm"
                                                rounded="sm"
                                                coverKind="song"
                                            />
                                            <div className="b-search-lyric-modal__item-info">
                                                <div className="b-search-lyric-modal__item-title">
                                                    {item.title}
                                                </div>
                                                <div className="b-search-lyric-modal__item-artist">
                                                    {item.artist}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                            </>
                        ))}

                    {origin === 'local' && (
                        <>
                            <StatusPlaceholder
                                status={
                                    fileListLoading ? RequestStatus.Pending : RequestStatus.Done
                                }
                                isEmpty={!fileListLoading && filteredLocal.length === 0}
                                emptyTitle={
                                    (localLyrics?.length ?? 0) === 0
                                        ? t('lyric.local_empty')
                                        : t('lyric.no_result')
                                }
                            />
                            {!fileListLoading &&
                                filteredLocal.map((item) => (
                                    <button
                                        key={item.filePath}
                                        type="button"
                                        className="b-search-lyric-modal__item"
                                        disabled={linking}
                                        title={item.filePath}
                                        onClick={() => handleSelectLocal(item)}
                                    >
                                        <Artwork
                                            src={undefined}
                                            size="sm"
                                            rounded="sm"
                                            coverKind="song"
                                        />
                                        <div className="b-search-lyric-modal__item-info">
                                            <div className="b-search-lyric-modal__item-title">
                                                {item.title}
                                                {!item.audioPath && (
                                                    <Badge
                                                        variant="outline"
                                                        className="b-search-lyric-modal__item-badge"
                                                    >
                                                        {t('lyric.local_orphan')}
                                                    </Badge>
                                                )}
                                            </div>
                                            <div className="b-search-lyric-modal__item-artist">
                                                {item.artist || item.fileName}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                        </>
                    )}

                    {origin === 'cloud' && (
                        <>
                            <StatusPlaceholder
                                status={
                                    fileListLoading ? RequestStatus.Pending : RequestStatus.Done
                                }
                                isEmpty={!fileListLoading && filteredCloud.length === 0}
                                emptyTitle={
                                    (cloudLyrics?.length ?? 0) === 0
                                        ? t('lyric.cloud_empty')
                                        : t('lyric.no_result')
                                }
                            />
                            {!fileListLoading &&
                                filteredCloud.map((item) => (
                                    <button
                                        key={item.remotePath}
                                        type="button"
                                        className="b-search-lyric-modal__item"
                                        disabled={linking}
                                        title={item.remotePath}
                                        onClick={() => handleSelectCloud(item)}
                                    >
                                        <Artwork
                                            src={undefined}
                                            size="sm"
                                            rounded="sm"
                                            coverKind="song"
                                        />
                                        <div className="b-search-lyric-modal__item-info">
                                            <div className="b-search-lyric-modal__item-title">
                                                {item.title}
                                            </div>
                                            <div className="b-search-lyric-modal__item-artist">
                                                {item.artist || item.name}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                        </>
                    )}
                </ScrollArea>
            </div>
        </Modal>
    );
}
