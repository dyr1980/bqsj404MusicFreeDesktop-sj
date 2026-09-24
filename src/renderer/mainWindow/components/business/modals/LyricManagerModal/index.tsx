import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai/react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowLeft, Download, Search, Trash2, Upload } from 'lucide-react';
import { cn } from '@common/cn';
import { RequestStatus } from '@common/constant';
import debounce from '@common/debounce';
import { buildMediaNameKey } from '@common/mediaNameKey';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { ScrollArea } from '@renderer/mainWindow/components/ui/ScrollArea';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showContextMenu } from '@renderer/mainWindow/components/ui/ContextMenu/contextMenuManager';
import { useMultiSelect } from '@renderer/mainWindow/hooks/useMultiSelect';
import {
    allLocalMusicAtom,
    ensureLocalMusicStore,
    localMusicLoadingAtom,
} from '@renderer/mainWindow/core/localLibrary';
import {
    CloudLyricIcon,
    DeleteCloudLyricIcon,
    LinkLyricIcon,
    LocalLyricIcon,
    UnlinkLyricIcon,
    ViewLyricIcon,
} from '../../LyricIcons';
import type { ILyricMenuRow, TLyricMenuAction } from '../../contextMenus/LyricRowMenu';
import appConfig from '@infra/appConfig/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import localMusic from '@infra/localMusic/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import localSource from '@renderer/mainWindow/core/localSource';
import {
    buildLyricEntries,
    buildLyricRows,
    downloadCandidates,
    expectedLyricPath,
    lyricBaseName,
    rowHasLyric,
    type ILyricRow,
    type TLyricEntry,
    type TLyricFilter,
    type TLyricRowItem,
    type TLyricScope,
    type TLyricSelectableEntry,
} from './lyricRows';
import type { ICloudLyricFile, ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import type { ILocalLyricItem } from '@appTypes/infra/localMusic';
import type { IMediaMeta } from '@appTypes/infra/mediaMeta';
import './index.scss';

export interface LyricManagerModalProps {
    /** 从哪个页面打开：本地音乐 / 云端音乐 / 下载管理 */
    scope: TLyricScope;
    close: () => void;
}

/** 下载记录（只需要这几列） */
interface IDownloadRecordSlim {
    platform: string;
    musicId: string;
    path?: string;
    title?: string;
    artist?: string;
}

/** 一次拉取到的「文件 / 记录」来源 */
interface ISources {
    cloudItems: TLyricRowItem[];
    localLyrics: ILocalLyricItem[];
    cloudLyrics: ICloudLyricFile[];
    downloads: IDownloadRecordSlim[];
    uploads: ICloudUploadRecord[];
    /** 已手动关联歌词的记录（未匹配判断要用：它可能只有插件来源、本地云端都没文件） */
    associatedRows: Array<{ platform: string; musicId: string; meta: IMediaMeta }>;
    /** 扫描目录之外、经 stat 确认存在的同名 .lrc（扫描到的那些不用再 stat） */
    extraLyricPaths: Set<string>;
}

/** 查看面板的状态 */
interface IViewerState {
    title: string;
    text: string;
    /** 文本来源（用于标题下的说明） */
    from: 'linked' | 'local' | 'cloud';
    /** 来源文件路径 / 远端路径 */
    path?: string;
    /** 关联来源的描述 */
    linkedFrom?: string;
}

/** 查看面板的取源入参（歌曲行和未匹配行都能喂进来） */
interface IViewerSource {
    title: string;
    linkedText?: string;
    linkedFrom?: string;
    localLyricPath?: string;
    /** 云端歌词的逻辑名（`<歌名 - 歌手>.lrc`） */
    cloudName?: string;
    cloudRemotePath?: string;
}

/** 存在性校验并发（和 core/localSource 一致） */
const EXISTS_CONCURRENCY = 32;

/** 事件驱动的刷新防抖：一次操作常常同时触发多个事件 */
const RELOAD_DEBOUNCE_MS = 200;

/**
 * LyricManagerModal — 歌词文件与关联记录的管理弹窗
 *
 * 只做「歌词文件 / 关联记录」的管理：
 *   查看 · 关联（复用搜索歌词弹窗）· 取消关联 · 上传到云端 · 保存到本地 · 删除
 *
 * ⚠️ 不碰播放时的歌词逻辑（偏移、显示、桌面歌词都在 lyricManager / 播放器那侧）：
 * 取消关联会写 mediaMeta（播放取源链本来就优先读它，属于既有语义）。
 *
 * 数据与刷新口径和「本地音乐 / 云端音乐」两个页面保持一致：
 *   - 歌曲全集、本地歌词来自常驻缓存（core/localLibrary + localMusic 推送）
 *   - 云盘列表走主进程 60s 缓存，不强制刷新
 *   - 订阅 cloudDisk.onFilesChanged / localMusic.onLibraryChanged / mediaMeta.onMetaChanged，
 *     别处（网盘网页端、上传完成、关联变更）改了东西，弹窗开着也能自己更新
 *   - 自己改完不再整表重来：云端/关联变更由事件驱动，本地文件增删补一次本地刷新
 *
 * 列表用 Virtuoso 虚拟滚动（和歌曲列表同一套），几千首歌也只挂可视区那几十行。
 * 多选语义走 core/selection（Ctrl 切换 / Shift 连选 / Ctrl+A / Esc），批量操作在右键菜单。
 */
export default function LyricManagerModal({ scope, close }: LyricManagerModalProps) {
    const { t } = useTranslation();

    // ── 常驻缓存：本地音乐库全集（事件驱动刷新，不做 minDuration 过滤） ──
    const libraryItems = useAtomValue(allLocalMusicAtom);
    const libraryLoading = useAtomValue(localMusicLoadingAtom);
    const libraryRef = useRef(libraryItems);
    libraryRef.current = libraryItems;

    const [sources, setSources] = useState<ISources | null>(null);
    const [keyword, setKeyword] = useState('');
    const [filter, setFilter] = useState<TLyricFilter>('all');
    const [viewer, setViewer] = useState<IViewerState | null>(null);
    const [busy, setBusy] = useState(false);

    // ── 初始化常驻 store（幂等：本地音乐页面已经进过就什么都不做） ──
    useEffect(() => {
        ensureLocalMusicStore();
    }, []);

    /**
     * 拉一次「文件 / 记录」来源。
     *
     * 云盘列表**不吃 force**（主进程 60s 缓存），本地歌词与关联记录仍然是现读；
     * 同名 .lrc 的存在性只对**扫描目录之外**的音频做 stat —— 本地音乐库里的歌
     * 扫描器已经同步过歌词表，缺了就是真没有，不必一千首歌打一千次 stat。
     */
    const loadSources = useCallback(async (): Promise<void> => {
        const [localLyrics, cloudLyrics, cloudItems, downloads, uploads, associatedRows] =
            await Promise.all([
                localMusic.getAllLocalLyrics().catch((): ILocalLyricItem[] => []),
                cloudDisk.listLyricFiles().catch((): ICloudLyricFile[] => []),
                scope === 'cloud'
                    ? cloudDisk.getAllItems().catch((): TLyricRowItem[] => [])
                    : Promise.resolve<TLyricRowItem[]>([]),
                downloadManager.getAllDownloaded().catch((): IDownloadRecordSlim[] => []),
                cloudDisk.getAllUploads().catch((): ICloudUploadRecord[] => []),
                mediaMeta
                    .queryByField('associatedLyric')
                    .catch((): ISources['associatedRows'] => []),
            ]);

        const items = pickItems(
            scope,
            libraryRef.current,
            cloudItems,
            downloads ?? [],
            uploads ?? [],
        );

        // 扫描器认得（= 在本地音乐库里）的音频：歌词表就是权威，不用再 stat
        const scannedAudio = new Set<string>();
        for (const item of libraryRef.current) {
            if (typeof item.localPath === 'string' && item.localPath)
                scannedAudio.add(item.localPath);
        }
        const extraLyricPaths = await statExtraLyricPaths(items, scannedAudio);

        await mediaMeta
            .preload(items.map((item) => ({ platform: item.platform, id: String(item.id) })))
            .catch((): void => undefined);

        setSources({
            cloudItems: cloudItems ?? [],
            localLyrics: localLyrics ?? [],
            cloudLyrics: cloudLyrics ?? [],
            downloads: downloads ?? [],
            uploads: uploads ?? [],
            associatedRows: associatedRows ?? [],
            extraLyricPaths,
        });
    }, [scope]);

    useEffect(() => {
        void loadSources();
    }, [loadSources]);

    // ── 别处改了东西 → 防抖后重拉（云盘内容 / 本地库 / 关联记录） ──
    const scheduledReload = useMemo(
        () => debounce(() => void loadSources(), RELOAD_DEBOUNCE_MS),
        [loadSources],
    );

    useEffect(() => {
        const offCloud = cloudDisk.onFilesChanged(scheduledReload);
        const offLibrary = localMusic.onLibraryChanged(scheduledReload);
        const offMeta = mediaMeta.onMetaChanged(scheduledReload);
        return () => {
            offCloud();
            offLibrary();
            offMeta();
        };
    }, [scheduledReload]);

    // ── 行模型 ──
    const rows = useMemo((): ILyricRow[] => {
        if (!sources) return [];
        const items = pickItems(
            scope,
            libraryItems,
            sources.cloudItems,
            sources.downloads,
            sources.uploads,
        );
        return buildLyricRows({
            scope,
            items,
            localLyrics: sources.localLyrics,
            cloudLyrics: sources.cloudLyrics,
            existingLyricPaths: sources.extraLyricPaths,
            resolveLocalPath: (item) => localSource.getPath(item) ?? undefined,
            metaOf: (platform, id) => mediaMeta.getMetaSync(platform, id),
        });
    }, [scope, libraryItems, sources]);

    /** 本地未匹配歌词：扫描器已判定「同目录没有同名音频」 */
    const orphanLocal = useMemo(
        () => (sources ? sources.localLyrics.filter((lyric) => !lyric.audioPath) : []),
        [sources],
    );

    /**
     * 云端未匹配歌词：在当前知道的**所有**歌曲（本地库 + 云盘 + 下载/上传记录 +
     * 已关联歌词）里都找不到同名作品 —— 多半是歌没了、歌词留在了云上。
     */
    const orphanCloud = useMemo((): ICloudLyricFile[] => {
        if (!sources) return [];
        const knownWorkKeys = new Set<string>();
        for (const item of [...libraryItems, ...sources.cloudItems]) {
            const key = buildMediaNameKey(item.title, item.artist);
            if (key) knownWorkKeys.add(key);
        }
        for (const record of [...sources.downloads, ...sources.uploads]) {
            const key = buildMediaNameKey(record.title, record.artist);
            if (key) knownWorkKeys.add(key);
        }
        for (const row of sources.associatedRows) {
            const item = row.meta?.associatedLyric?.musicItem;
            const key = buildMediaNameKey(item?.title, item?.artist);
            if (key) knownWorkKeys.add(key);
        }
        return sources.cloudLyrics.filter((file) => {
            const key = buildMediaNameKey(file.title, file.artist);
            return !key || !knownWorkKeys.has(key);
        });
    }, [sources, libraryItems]);

    // ── 列表条目：歌曲行 + 未匹配歌词（并入同一列表，按来源分组）+ 筛选计数 ──
    const { entries, selectables, counts } = useMemo(
        () =>
            buildLyricEntries({
                rows,
                orphanLocal,
                orphanCloud,
                filter,
                keyword: keyword.trim(),
            }),
        [rows, orphanLocal, orphanCloud, filter, keyword],
    );

    // ── 多选（语义见 core/selection；没有勾选框，批量操作在右键菜单） ──
    const listRef = useRef<HTMLDivElement>(null);
    const getEntryId = useCallback((entry: TLyricSelectableEntry) => entry.key, []);
    const { selectedIds, handleRowClick, resolveContextSelection } =
        useMultiSelect<TLyricSelectableEntry>({
            items: selectables,
            getId: getEntryId,
            resetDeps: [scope, filter, keyword],
            rootRef: listRef,
        });

    /** 读本地歌词文件内容（读不到返回 null） */
    const readLocalLyric = useCallback(async (filePath: string): Promise<string | null> => {
        try {
            const content = await fsUtil.readFile(filePath, 'utf-8');
            return typeof content === 'string'
                ? content
                : new TextDecoder().decode(content as unknown as ArrayBuffer);
        } catch {
            return null;
        }
    }, []);

    /** 查看：手动关联 → 本地文件 → 云端，取第一个读得到的 */
    const openViewer = useCallback(
        async (source: IViewerSource) => {
            setBusy(true);
            try {
                if (source.linkedText) {
                    setViewer({
                        title: source.title,
                        text: source.linkedText,
                        from: 'linked',
                        linkedFrom: source.linkedFrom,
                    });
                    return;
                }
                if (source.localLyricPath) {
                    const text = await readLocalLyric(source.localLyricPath);
                    if (text !== null) {
                        setViewer({
                            title: source.title,
                            text,
                            from: 'local',
                            path: source.localLyricPath,
                        });
                        return;
                    }
                }
                if (source.cloudName) {
                    const text = await cloudDisk
                        .getLyricText(source.cloudName)
                        .catch((): string | null => null);
                    if (text) {
                        setViewer({
                            title: source.title,
                            text,
                            from: 'cloud',
                            path: source.cloudRemotePath,
                        });
                        return;
                    }
                }
                // 关联了但没缓存文本：让用户去「关联歌词」里换一份
                showToast(t('lyric.manage.no_text'), { type: 'warn' });
            } finally {
                setBusy(false);
            }
        },
        [readLocalLyric, t],
    );

    /** 条目 → 右键菜单行（批量动作与内联按钮共用同一套入参） */
    const toMenuRow = useCallback((entry: TLyricSelectableEntry): ILyricMenuRow => {
        if (entry.kind === 'song') {
            const row = entry.row;
            return {
                key: entry.key,
                kind: 'song',
                title: row.title,
                artist: row.artist,
                item: row.item,
                viewable: !!(row.linkedText || row.localLyricPath || row.cloudLyric),
                linked: row.linked,
                linkedText: row.linkedText,
                linkedFrom: row.linkedFrom,
                localLyricPath: row.localLyricPath,
                localAudioPath: row.localAudioPath,
                cloudName: row.cloudLyric ? lyricBaseName(row.title, row.artist) : undefined,
                cloudRemotePath: row.cloudLyric?.remotePath,
                uploadable: !row.cloudLyric && !!(row.localLyricPath || row.linkedText),
                downloadable: !!row.cloudLyric && !row.localLyricPath,
            };
        }
        if (entry.source === 'local') {
            return {
                key: entry.key,
                kind: 'orphan-local',
                title: entry.lyric.fileName,
                viewable: true,
                localLyricPath: entry.lyric.filePath,
            };
        }
        return {
            key: entry.key,
            kind: 'orphan-cloud',
            title: entry.file.name,
            viewable: true,
            cloudName: entry.file.name,
            cloudRemotePath: entry.file.remotePath,
        };
    }, []);

    const viewerSourceOf = useCallback(
        (menuRow: ILyricMenuRow): IViewerSource => ({
            title: menuRow.title,
            linkedText: menuRow.linkedText,
            linkedFrom: menuRow.linkedFrom,
            localLyricPath: menuRow.localLyricPath,
            cloudName: menuRow.cloudName,
            cloudRemotePath: menuRow.cloudRemotePath,
        }),
        [],
    );

    // ── 批量动作（内联按钮 = 只传一行） ──

    /** 取消关联（只清 mediaMeta 里的关联记录） */
    const unlinkRows = useCallback(
        async (targets: ILyricMenuRow[]) => {
            const usable = targets.filter((row) => row.item);
            if (!usable.length) return;
            setBusy(true);
            try {
                for (const row of usable) {
                    const item = row.item!;
                    await mediaMeta
                        .setMeta(
                            item.platform,
                            String(item.id),
                            { associatedLyric: null },
                            { title: row.title, artist: row.artist },
                        )
                        .catch((): void => undefined);
                }
                showToast(
                    usable.length === 1
                        ? t('lyric.manage.unlinked')
                        : t('lyric.manage.bulk_unlinked', { count: usable.length }),
                );
                // 关联记录变更会广播 → 事件驱动的重拉自己会更新列表
            } finally {
                setBusy(false);
            }
        },
        [t],
    );

    /** 上传到云端：本地 .lrc 或关联文本 → /MusicFree/lyrics */
    const uploadRows = useCallback(
        async (targets: ILyricMenuRow[]) => {
            setBusy(true);
            try {
                let done = 0;
                for (const row of targets) {
                    let text: string | null = null;
                    if (row.localLyricPath) text = await readLocalLyric(row.localLyricPath);
                    if (!text && row.linkedText) text = row.linkedText;
                    if (!text) continue;
                    const ok = await cloudDisk.putLyricText(
                        lyricBaseName(row.title, row.artist ?? ''),
                        text,
                    );
                    if (ok) done++;
                }

                if (!done) {
                    showToast(t('lyric.manage.upload_failed'), { type: 'warn' });
                    return;
                }
                showToast(
                    done === 1
                        ? t('lyric.manage.uploaded')
                        : t('lyric.manage.bulk_uploaded', { count: done }),
                );
                // 主进程 putLyricText 成功后会广播云盘内容变化 → 事件驱动重拉
            } finally {
                setBusy(false);
            }
        },
        [readLocalLyric, t],
    );

    /** 保存到本地：云端歌词 → 音频同目录同名 .lrc；本地没有音频则存到歌词目录 */
    const downloadRows = useCallback(
        async (targets: ILyricMenuRow[]) => {
            setBusy(true);
            try {
                let done = 0;
                let lastPath = '';
                for (const row of targets) {
                    const name =
                        row.cloudName ?? `${lyricBaseName(row.title, row.artist ?? '')}.lrc`;
                    const text = await cloudDisk
                        .getLyricText(name)
                        .catch((): string | null => null);
                    if (!text) continue;

                    let target: string;
                    if (row.localAudioPath) {
                        target = expectedLyricPath(row.localAudioPath);
                    } else {
                        // 本地没有这首歌的文件：落到「设置 → 下载 → 歌词路径」（没配就跟随下载目录）
                        const dir =
                            appConfig.getConfigByKey('download.lyricPath')?.trim() ||
                            appConfig.getConfigByKey('download.path') ||
                            window.globalContext.appPath.defaultDownloadPath;
                        target = `${dir}${fsUtil.pathSep}${name}`;
                    }

                    try {
                        await fsUtil.writeFile(target, text, { encoding: 'utf-8' });
                    } catch {
                        continue;
                    }
                    done++;
                    lastPath = target;
                }

                if (!done) {
                    showToast(t('lyric.manage.download_failed'), { type: 'warn' });
                    return;
                }
                showToast(
                    done === 1
                        ? t('lyric.manage.downloaded', { path: lastPath })
                        : t('lyric.manage.bulk_downloaded', { count: done }),
                );
                // 写本地文件没有事件 → 自己补一次（只补本地歌词与存在性）
                void loadSources();
            } finally {
                setBusy(false);
            }
        },
        [loadSources, t],
    );

    /** 删除本地歌词文件 */
    const deleteLocalRows = useCallback(
        (targets: ILyricMenuRow[]) => {
            const files = targets.filter((row) => row.localLyricPath);
            if (!files.length) return;
            showModal('ConfirmModal', {
                title: t('local_music.confirm_delete_title'),
                message:
                    files.length === 1
                        ? t('lyric.manage.confirm_delete_local', { path: files[0].localLyricPath })
                        : t('lyric.manage.confirm_delete_local_batch', { count: files.length }),
                confirmDanger: true,
                onConfirm: async () => {
                    let done = 0;
                    for (const row of files) {
                        try {
                            await fsUtil.rimraf(row.localLyricPath!);
                            done++;
                        } catch {
                            // 单个失败不影响其它
                        }
                    }
                    if (!done) {
                        showToast(t('lyric.manage.download_failed'), { type: 'warn' });
                        return;
                    }
                    showToast(
                        done === 1
                            ? t('lyric.manage.deleted_local')
                            : t('lyric.manage.bulk_deleted_local', { count: done }),
                    );
                    // 删本地文件没有事件 → 自己补一次
                    void loadSources();
                },
            });
        },
        [loadSources, t],
    );

    /** 删除云端歌词（移入云盘回收站） */
    const deleteCloudRows = useCallback(
        (targets: ILyricMenuRow[]) => {
            const paths = targets
                .map((row) => row.cloudRemotePath)
                .filter((path): path is string => !!path);
            if (!paths.length) return;
            showModal('ConfirmModal', {
                title: t('local_music.confirm_delete_title'),
                message:
                    paths.length === 1
                        ? t('lyric.manage.confirm_delete_cloud', { path: paths[0] })
                        : t('lyric.manage.confirm_delete_cloud_batch', { count: paths.length }),
                confirmDanger: true,
                onConfirm: async () => {
                    const moved = await cloudDisk.moveToTrash(paths);
                    if (moved > 0) {
                        showToast(
                            moved === 1
                                ? t('lyric.manage.deleted_cloud')
                                : t('lyric.manage.bulk_deleted_cloud', { count: moved }),
                        );
                    } else {
                        showToast(t('lyric.manage.download_failed'), { type: 'warn' });
                    }
                    // 移入回收站会广播云盘内容变化 → 事件驱动重拉
                },
            });
        },
        [t],
    );

    // ── 内联按钮 / 右键菜单的入口 ──
    const handleInlineView = useCallback(
        (entry: TLyricSelectableEntry): void => {
            void openViewer(viewerSourceOf(toMenuRow(entry)));
        },
        [openViewer, toMenuRow, viewerSourceOf],
    );

    const handleInlineLink = useCallback((entry: TLyricSelectableEntry): void => {
        if (entry.kind !== 'song') return;
        showModal('SearchLyricModal', { musicItem: entry.row.item });
    }, []);

    const handleInlineUnlink = useCallback(
        (entry: TLyricSelectableEntry): void => {
            void unlinkRows([toMenuRow(entry)]);
        },
        [toMenuRow, unlinkRows],
    );
    const handleInlineUpload = useCallback(
        (entry: TLyricSelectableEntry): void => {
            void uploadRows([toMenuRow(entry)]);
        },
        [toMenuRow, uploadRows],
    );
    const handleInlineDownload = useCallback(
        (entry: TLyricSelectableEntry): void => {
            void downloadRows([toMenuRow(entry)]);
        },
        [toMenuRow, downloadRows],
    );
    const handleInlineDeleteLocal = useCallback(
        (entry: TLyricSelectableEntry): void => {
            deleteLocalRows([toMenuRow(entry)]);
        },
        [deleteLocalRows, toMenuRow],
    );
    const handleInlineDeleteCloud = useCallback(
        (entry: TLyricSelectableEntry): void => {
            deleteCloudRows([toMenuRow(entry)]);
        },
        [deleteCloudRows, toMenuRow],
    );

    const handleMenuView = useCallback(
        (menuRow: ILyricMenuRow): void => {
            void openViewer(viewerSourceOf(menuRow));
        },
        [openViewer, viewerSourceOf],
    );

    const handleMenuAction = useCallback(
        (action: TLyricMenuAction, targets: ILyricMenuRow[]) => {
            if (action === 'unlink') void unlinkRows(targets);
            else if (action === 'upload') void uploadRows(targets);
            else if (action === 'download') void downloadRows(targets);
            else if (action === 'deleteLocal') deleteLocalRows(targets);
            else if (action === 'deleteCloud') deleteCloudRows(targets);
        },
        [deleteCloudRows, deleteLocalRows, downloadRows, unlinkRows, uploadRows],
    );

    /** 行点击 → 多选 */
    const handleEntryClick = useCallback(
        (entry: TLyricSelectableEntry, e: MouseEvent) => {
            handleRowClick(entry.selectIndex, e);
        },
        [handleRowClick],
    );

    /** 右键 → 整行高亮 + 菜单（点中的行不在选区里时先把它变成单选） */
    const handleEntryContextMenu = useCallback(
        (entry: TLyricSelectableEntry, e: MouseEvent) => {
            e.preventDefault();
            const picked = resolveContextSelection(entry.selectIndex);
            const targets = (picked.length ? picked : [entry]).map(toMenuRow);
            showContextMenu(
                'LyricRowMenu',
                { x: e.clientX, y: e.clientY },
                { rows: targets, onView: handleMenuView, onAction: handleMenuAction },
            );
        },
        [handleMenuAction, handleMenuView, resolveContextSelection, toMenuRow],
    );

    const titleKey =
        scope === 'local'
            ? 'lyric.manage.title_local'
            : scope === 'cloud'
              ? 'lyric.manage.title_cloud'
              : 'lyric.manage.title_download';

    // ── 查看面板 ──
    if (viewer) {
        const sourceText =
            viewer.from === 'linked'
                ? t('lyric.manage.viewer_source_linked', { from: viewer.linkedFrom ?? '' })
                : viewer.from === 'local'
                  ? t('lyric.manage.viewer_source_local', { path: viewer.path ?? '' })
                  : t('lyric.manage.viewer_source_cloud', { path: viewer.path ?? '' });

        return (
            <Modal
                open
                onClose={close}
                size="lg"
                title={t('lyric.manage.viewer_title', { title: viewer.title })}
                subtitle={sourceText}
            >
                <div className="b-lyric-manager">
                    <div className="b-lyric-manager__viewer-toolbar">
                        <Button
                            variant="ghost"
                            size="sm"
                            icon={<ArrowLeft size={15} />}
                            onClick={() => setViewer(null)}
                        >
                            {t('lyric.manage.back')}
                        </Button>
                    </div>
                    <ScrollArea className="b-lyric-manager__viewer">
                        <pre className="b-lyric-manager__lyric-text">{viewer.text}</pre>
                    </ScrollArea>
                </div>
            </Modal>
        );
    }

    const loading = sources === null || (libraryLoading && libraryItems.length === 0);

    return (
        <Modal
            open
            onClose={close}
            size="lg"
            title={t(titleKey)}
            subtitle={t('lyric.manage.stats', {
                total: rows.length,
                withLyric: counts.has,
            })}
        >
            <div className="b-lyric-manager">
                {/* ── 搜索 + 筛选（未匹配也是一类，能搜、能多选） ── */}
                <div className="b-lyric-manager__toolbar">
                    <Input
                        className="b-lyric-manager__search"
                        prefix={<Search size={14} />}
                        placeholder={t('lyric.manage.search_placeholder')}
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        allowClear
                        onClear={() => setKeyword('')}
                    />
                    <div className="b-lyric-manager__filters">
                        {(['all', 'has', 'none', 'orphan'] as TLyricFilter[]).map((key) => (
                            <button
                                key={key}
                                type="button"
                                className={cn(
                                    'b-lyric-manager__filter',
                                    filter === key && 'is-active',
                                )}
                                onClick={() => setFilter(key)}
                            >
                                {t(`lyric.manage.filter_${key}`)}
                                <span className="b-lyric-manager__filter-count">{counts[key]}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {filter === 'orphan' && (
                    <div className="b-lyric-manager__hint">{t('lyric.manage.orphans_hint')}</div>
                )}

                {/* ── 列表（虚拟滚动；未匹配歌词按来源分组接在后面） ── */}
                {loading ? (
                    <div className="b-lyric-manager__list b-lyric-manager__list--empty">
                        <StatusPlaceholder status={RequestStatus.Pending} />
                    </div>
                ) : entries.length === 0 ? (
                    <div className="b-lyric-manager__list b-lyric-manager__list--empty">
                        <StatusPlaceholder
                            status={RequestStatus.Done}
                            isEmpty
                            emptyTitle={
                                rows.length === 0
                                    ? t('lyric.manage.empty')
                                    : t('lyric.manage.empty_filtered')
                            }
                        />
                    </div>
                ) : (
                    <div className="b-lyric-manager__list" ref={listRef}>
                        <Virtuoso
                            className="b-lyric-manager__scroller"
                            data={entries}
                            computeItemKey={(_, entry) => entry.key}
                            itemContent={(_, entry) =>
                                entry.kind === 'group' ? (
                                    <LyricGroupHeader entry={entry} />
                                ) : (
                                    <LyricRow
                                        entry={entry}
                                        selected={selectedIds.has(entry.key)}
                                        busy={busy}
                                        onClick={handleEntryClick}
                                        onContextMenu={handleEntryContextMenu}
                                        onView={handleInlineView}
                                        onLink={handleInlineLink}
                                        onUnlink={handleInlineUnlink}
                                        onUpload={handleInlineUpload}
                                        onDownload={handleInlineDownload}
                                        onDeleteLocal={handleInlineDeleteLocal}
                                        onDeleteCloud={handleInlineDeleteCloud}
                                    />
                                )
                            }
                        />
                    </div>
                )}
            </div>
        </Modal>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// 列表行（memo 化：筛选打关键字时只有变化的那几行重渲）
// ────────────────────────────────────────────────────────────────────────────

interface ILyricRowProps {
    entry: TLyricSelectableEntry;
    selected: boolean;
    busy: boolean;
    onClick: (entry: TLyricSelectableEntry, e: MouseEvent) => void;
    onContextMenu: (entry: TLyricSelectableEntry, e: MouseEvent) => void;
    onView: (entry: TLyricSelectableEntry) => void;
    onLink: (entry: TLyricSelectableEntry) => void;
    onUnlink: (entry: TLyricSelectableEntry) => void;
    onUpload: (entry: TLyricSelectableEntry) => void;
    onDownload: (entry: TLyricSelectableEntry) => void;
    onDeleteLocal: (entry: TLyricSelectableEntry) => void;
    onDeleteCloud: (entry: TLyricSelectableEntry) => void;
}

/** 未匹配区的分组标题（本地歌词 / 云端歌词） */
const LyricGroupHeader = memo(function LyricGroupHeader({
    entry,
}: {
    entry: Extract<TLyricEntry, { kind: 'group' }>;
}) {
    const { t } = useTranslation();
    return (
        <div className="b-lyric-manager__group">
            <span className="b-lyric-manager__group-icon">
                {entry.source === 'local' ? (
                    <LocalLyricIcon size={14} />
                ) : (
                    <CloudLyricIcon size={14} />
                )}
            </span>
            {t(entry.source === 'local' ? 'lyric.manage.badge_local' : 'lyric.manage.badge_cloud')}
            <span className="b-lyric-manager__group-count">{entry.count}</span>
        </div>
    );
});

const LyricRow = memo(function LyricRow({
    entry,
    selected,
    busy,
    onClick,
    onContextMenu,
    onView,
    onLink,
    onUnlink,
    onUpload,
    onDownload,
    onDeleteLocal,
    onDeleteCloud,
}: ILyricRowProps) {
    const { t } = useTranslation();
    const actionProps = useCallback(
        (handler: (entry: TLyricSelectableEntry) => void) => ({
            disabled: busy,
            onClick: (e: MouseEvent) => {
                // 点操作按钮不改变选中状态（和其它列表一致）
                e.stopPropagation();
                handler(entry);
            },
        }),
        [busy, entry],
    );

    if (entry.kind === 'orphan') {
        const isLocal = entry.source === 'local';
        const name = isLocal ? entry.lyric.fileName : entry.file.name;
        return (
            <div
                className={cn('b-lyric-manager__orphan', selected && 'is-selected')}
                onClick={(e) => onClick(entry, e)}
                onContextMenu={(e) => onContextMenu(entry, e)}
            >
                <span className="b-lyric-manager__orphan-icon">
                    {isLocal ? <LocalLyricIcon size={15} /> : <CloudLyricIcon size={15} />}
                </span>
                <span className="b-lyric-manager__orphan-name">{name}</span>
                <div className="b-lyric-manager__actions">
                    <button
                        type="button"
                        className="b-lyric-manager__action"
                        title={t('lyric.manage.action_view')}
                        {...actionProps(onView)}
                    >
                        <ViewLyricIcon size={16} />
                    </button>
                    <button
                        type="button"
                        className="b-lyric-manager__action b-lyric-manager__action--danger"
                        title={
                            isLocal
                                ? t('lyric.manage.action_delete_local')
                                : t('lyric.manage.action_delete_cloud')
                        }
                        {...actionProps(isLocal ? onDeleteLocal : onDeleteCloud)}
                    >
                        {isLocal ? <Trash2 size={15} /> : <DeleteCloudLyricIcon size={16} />}
                    </button>
                </div>
            </div>
        );
    }

    const row = entry.row;
    const hasLyric = rowHasLyric(row);

    return (
        <div
            className={cn('b-lyric-manager__item', selected && 'is-selected')}
            onClick={(e) => onClick(entry, e)}
            onContextMenu={(e) => onContextMenu(entry, e)}
        >
            <div className="b-lyric-manager__item-main">
                <span className="b-lyric-manager__song">{row.title}</span>
                {row.artist && <span className="b-lyric-manager__artist">{row.artist}</span>}
            </div>

            {/* 状态列：三个固定图标位（有＝亮、无＝压暗），列宽固定所以在行的正中间 */}
            <div className="b-lyric-manager__status">
                <span
                    className={cn('b-lyric-manager__status-slot', row.localLyricPath && 'is-on')}
                    title={`${t('lyric.manage.badge_local')}：${
                        row.localLyricPath ? t('lyric.manage.has') : t('lyric.manage.none')
                    }${row.localLyricPath ? `（${row.localLyricPath}）` : ''}`}
                >
                    <LocalLyricIcon size={16} />
                </span>
                <span
                    className={cn('b-lyric-manager__status-slot', row.cloudLyric && 'is-on')}
                    title={`${t('lyric.manage.badge_cloud')}：${
                        row.cloudLyric ? t('lyric.manage.has') : t('lyric.manage.none')
                    }${row.cloudLyric ? `（${row.cloudLyric.remotePath}）` : ''}`}
                >
                    <CloudLyricIcon size={16} />
                </span>
                <span
                    className={cn('b-lyric-manager__status-slot', row.linked && 'is-on')}
                    title={`${t('lyric.manage.badge_linked')}：${
                        row.linked ? t('lyric.manage.has') : t('lyric.manage.none')
                    }${row.linked && row.linkedFrom ? `（${row.linkedFrom}）` : ''}`}
                >
                    <LinkLyricIcon size={16} />
                </span>
            </div>

            <div className="b-lyric-manager__actions">
                {hasLyric && (
                    <button
                        type="button"
                        className="b-lyric-manager__action"
                        title={t('lyric.manage.action_view')}
                        {...actionProps(onView)}
                    >
                        <ViewLyricIcon size={16} />
                    </button>
                )}
                <button
                    type="button"
                    className="b-lyric-manager__action"
                    title={t('lyric.manage.action_link')}
                    {...actionProps(onLink)}
                >
                    <Search size={15} />
                </button>
                {row.linked && (
                    <button
                        type="button"
                        className="b-lyric-manager__action"
                        title={t('lyric.manage.action_unlink')}
                        {...actionProps(onUnlink)}
                    >
                        <UnlinkLyricIcon size={16} />
                    </button>
                )}
                {!row.cloudLyric && (row.localLyricPath || row.linkedText) && (
                    <button
                        type="button"
                        className="b-lyric-manager__action"
                        title={t('lyric.manage.action_upload')}
                        {...actionProps(onUpload)}
                    >
                        <Upload size={15} />
                    </button>
                )}
                {row.cloudLyric && !row.localLyricPath && (
                    <button
                        type="button"
                        className="b-lyric-manager__action"
                        title={t('lyric.manage.action_download')}
                        {...actionProps(onDownload)}
                    >
                        <Download size={15} />
                    </button>
                )}
                {row.localLyricPath && (
                    <button
                        type="button"
                        className="b-lyric-manager__action b-lyric-manager__action--danger"
                        title={t('lyric.manage.action_delete_local')}
                        {...actionProps(onDeleteLocal)}
                    >
                        <Trash2 size={15} />
                    </button>
                )}
                {row.cloudLyric && (
                    <button
                        type="button"
                        className="b-lyric-manager__action b-lyric-manager__action--danger"
                        title={t('lyric.manage.action_delete_cloud')}
                        {...actionProps(onDeleteCloud)}
                    >
                        <DeleteCloudLyricIcon size={16} />
                    </button>
                )}
            </div>
        </div>
    );
});

// ────────────────────────────────────────────────────────────────────────────
// 纯函数辅助
// ────────────────────────────────────────────────────────────────────────────

/** 当前页面的候选歌曲（本地库 / 云盘 / 下载记录 + 上传清单） */
function pickItems(
    scope: TLyricScope,
    library: readonly TLyricRowItem[],
    cloudItems: readonly TLyricRowItem[],
    downloads: ReadonlyArray<IDownloadRecordSlim>,
    uploads: readonly ICloudUploadRecord[],
): TLyricRowItem[] {
    if (scope === 'local') return [...library];
    if (scope === 'cloud') return [...cloudItems];
    return downloadCandidates({ downloaded: downloads, uploads });
}

/**
 * 扫描目录之外的音频：按「音频同名 .lrc」推算后 stat 确认。
 *
 * 本地音乐库里的音频不在候选里（扫描器已经把歌词表同步过了）。
 */
async function statExtraLyricPaths(
    items: readonly TLyricRowItem[],
    scannedAudio: ReadonlySet<string>,
): Promise<Set<string>> {
    const candidates = new Set<string>();
    for (const item of items) {
        const localPath =
            (typeof (item as IMusic.IMusicItem).localPath === 'string'
                ? (item as IMusic.IMusicItem).localPath
                : undefined) || localSource.getPath(item);
        if (!localPath || scannedAudio.has(localPath)) continue;
        candidates.add(expectedLyricPath(localPath));
    }

    const list = [...candidates];
    const existing = new Set<string>();
    for (let i = 0; i < list.length; i += EXISTS_CONCURRENCY) {
        const batch = list.slice(i, i + EXISTS_CONCURRENCY);
        const results = await Promise.all(
            batch.map(async (filePath) => ((await fsUtil.isFile(filePath)) ? filePath : null)),
        );
        for (const filePath of results) {
            if (filePath) existing.add(filePath);
        }
    }
    return existing;
}
