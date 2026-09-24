import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FolderOpen, Search, FileMusic } from 'lucide-react';
import appConfig from '@infra/appConfig/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import downloadManager, { useDownloadTasks } from '@infra/downloadManager/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import musicSheet from '@infra/musicSheet/renderer';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { HeaderFilter } from '../../components/ui/HeaderFilter';
import { showContextMenu } from '../../components/ui/ContextMenu/contextMenuManager';
import { showModal } from '../../components/ui/Modal/modalManager';
import { useMultiSelect } from '../../hooks/useMultiSelect';
import { DownloadTable } from './components/DownloadTable';
import {
    buildDownloadRows,
    matchesSearch,
    matchesStatusFilter,
    sortDownloadRows,
    type IDownloadRow,
    type TDownloadSortOrder,
    type TDownloadStatusFilter,
} from './downloadRows';
import type { ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { DOWNLOADED_SHEET_ID } from '@infra/musicSheet/common/constant';
import './index.scss';

/** 状态筛选顺序（也是页面上 chip 的顺序） */
const FILTERS: TDownloadStatusFilter[] = [
    'all',
    'downloading',
    'pending',
    'paused',
    'error',
    'done',
    'uploaded',
];

/**
 * DownloadPage — 下载管理
 *
 * 路由: /download
 *
 * 一个列表混三种记录（不再分「下载队列 / 已完成」两个 Tab）：
 *   - 下载任务（等待 / 下载中 / 已暂停 / 失败）
 *   - 已下载到本地的文件
 *   - 云端上传记录
 * 支持搜索、按状态筛选（表头 Excel 风格），默认按记录时间倒序（最新在最上面），
 * 点「时间」列头切换方向。
 *
 * 多选与全应用一致：普通单击单选、Ctrl 切换、Shift 连选、Ctrl+A 全选、Esc 取消；
 * 选中只做整行高亮，暂停 / 继续重试 / 移除任务 / 删除记录 / 删除文件 /
 * 移除上传记录 / 从云端删除都在右键菜单里。
 */
export default function DownloadPage() {
    const { t } = useTranslation();

    const tasks = useDownloadTasks();

    // 已下载记录（下载完成/删除会触发 downloadChange）
    const [downloaded, setDownloaded] = useState<
        Array<{
            platform: string;
            musicId: string;
            path: string;
            title?: string;
            artist?: string;
            downloadedAt?: number;
        }>
    >([]);
    // 本地文件大小（下载记录里没存 size，用路径去 stat；切歌/删文件后会重算）
    // ready = 这一轮 stat 是否已出结果（没出结果前不把「查不到大小」当成「文件不存在」）
    const [fileState, setFileState] = useState<{ sizes: Map<string, number>; ready: boolean }>(
        () => ({ sizes: new Map(), ready: false }),
    );
    // 已下载的标题/歌手/专辑：从 __downloaded__ 歌单读（下载记录里没有元数据）
    const [downloadedItems, setDownloadedItems] = useState<IMusicItemSlim[]>([]);
    // 云端上传清单
    const [uploads, setUploads] = useState<ICloudUploadRecord[]>([]);

    useEffect(() => {
        let aborted = false;
        const loadDownloaded = async () => {
            try {
                const list = await downloadManager.getAllDownloaded();
                if (!aborted) setDownloaded(list ?? []);
            } catch (err) {
                if (!aborted) console.warn('[DownloadPage] 读取下载记录失败:', err);
            }
        };
        void loadDownloaded();
        const unsubscribe = downloadManager.subscribeDownloadChange(() => void loadDownloaded());
        return () => {
            aborted = true;
            unsubscribe();
        };
    }, []);

    // 歌单里的元数据 + 云端上传清单（云端文件变化时跟着刷）
    useEffect(() => {
        let aborted = false;
        const load = async () => {
            try {
                const [list, record] = await Promise.all([
                    musicSheet.getSheetMusicList(DOWNLOADED_SHEET_ID),
                    cloudDisk.getAllUploads(),
                ]);
                if (aborted) return;
                setDownloadedItems(list ?? []);
                setUploads(record ?? []);
            } catch (err) {
                if (!aborted) console.warn('[DownloadPage] 读取记录失败:', err);
            }
        };
        void load();
        const unsubscribe = cloudDisk.onFilesChanged(() => void load());
        return () => {
            aborted = true;
            unsubscribe?.();
        };
    }, [downloaded.length]);

    // 本地文件大小：异步 stat 一遍（文件不多，一次 Promise.all）
    // 拿不到大小 = 文件不存在（stat 失败）→ 让「已下载」行说实话（见 downloadRows.missing）
    useEffect(() => {
        let aborted = false;
        const paths = downloaded.map((r) => r.path).filter(Boolean);
        if (!paths.length) {
            setFileState({ sizes: new Map(), ready: true });
            return;
        }
        setFileState((prev) => ({ ...prev, ready: false }));
        void Promise.all(
            paths.map(async (path) => [path, await fsUtil.getFileSize(path)] as const),
        ).then((entries) => {
            if (aborted) return;
            const sizes = new Map<string, number>();
            for (const [path, size] of entries) {
                if (typeof size === 'number') sizes.set(path, size);
            }
            setFileState({ sizes, ready: true });
        });
        return () => {
            aborted = true;
        };
    }, [downloaded]);

    const rows = useMemo(() => {
        const built = buildDownloadRows({ tasks, downloaded, downloadedItems, uploads });
        if (!fileState.ready) return built;

        return built.map((row) => {
            if (row.kind !== 'downloaded' || !row.path) return row;
            const size = fileState.sizes.get(row.path);
            return size === undefined
                ? { ...row, missing: true }
                : { ...row, size, missing: false };
        });
    }, [tasks, downloaded, downloadedItems, uploads, fileState]);

    // ── 排序：默认最新在前，点「时间」列头切换 ──
    const [sortOrder, setSortOrder] = useState<TDownloadSortOrder>('desc');
    const sortedRows = useMemo(() => sortDownloadRows(rows, sortOrder), [rows, sortOrder]);

    // ── 搜索 + 状态筛选 ──
    const [searchValue, setSearchValue] = useState('');
    const deferredSearch = useDeferredValue(searchValue);
    const [statusFilter, setStatusFilter] = useState<TDownloadStatusFilter>('all');

    const filteredRows = useMemo(() => {
        const keyword = deferredSearch.trim().toLowerCase();
        return sortedRows.filter(
            (row) => matchesStatusFilter(row, statusFilter) && matchesSearch(row, keyword),
        );
    }, [sortedRows, statusFilter, deferredSearch]);

    const counts = useMemo(() => {
        const map = new Map<TDownloadStatusFilter, number>();
        map.set('all', rows.length);
        for (const row of rows) {
            map.set(row.status, (map.get(row.status) ?? 0) + 1);
        }
        return map;
    }, [rows]);

    // ── 多选（Ctrl 切换 / Shift 连选 / Ctrl+A 全选 / Esc 取消，语义见 core/selection） ──
    const tableRootRef = useRef<HTMLDivElement>(null);
    const getId = useCallback((row: IDownloadRow) => row.key, []);
    const { selectedIds, handleRowClick, resolveContextSelection } = useMultiSelect<IDownloadRow>({
        items: filteredRows,
        getId,
        resetDeps: [statusFilter, deferredSearch],
        rootRef: tableRootRef,
    });

    // ── 单行交互 ──
    const handleRowDoubleClick = useCallback((row: IDownloadRow) => {
        // 任务行没有确定的落盘文件（可能还在下），双击不播
        if (row.kind !== 'task' && row.item) {
            trackPlayer.playMusic(row.item as IMusic.IMusicItem);
        }
    }, []);

    /**
     * 右键菜单 = 歌曲菜单 + 下载管理专用项。
     *
     * 暂停 / 继续重试 / 移除任务 / 删除记录 / 连本地文件一起删 都并进了这张菜单
     * （以前挂在多选操作条上），所以行上不再有勾选框、页面上不再有操作条。
     */
    const handleRowContextMenu = useCallback(
        (row: IDownloadRow, index: number, e: React.MouseEvent) => {
            const selected = resolveContextSelection(index);
            if (!selected.length) return;
            const musicItems = selected
                .map((r) => r.item)
                .filter((item): item is IMusic.IMusicItem | IMusicItemSlim => !!item);
            showContextMenu(
                'MusicItemMenu',
                { x: e.clientX, y: e.clientY },
                {
                    musicItems: musicItems as IMusic.IMusicItem[],
                    downloadRows: selected,
                },
            );
        },
        [resolveContextSelection],
    );

    const handleOpenFolder = useCallback(() => {
        const downloadPath =
            appConfig.getConfigByKey('download.path') ||
            window.globalContext.appPath.defaultDownloadPath;
        systemUtil.openPath(downloadPath);
    }, []);

    return (
        <div className="p-download">
            {/* ── 页头 ── */}
            <div className="p-download__header">
                <h2 className="p-download__title">{t('download.title')}</h2>
                <div className="p-download__header-actions">
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<FileMusic size={16} />}
                        onClick={() => showModal('LyricManagerModal', { scope: 'download' })}
                    >
                        {t('lyric.manage.open')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<FolderOpen size={16} />}
                        onClick={handleOpenFolder}
                    >
                        {t('download.open_download_folder')}
                    </Button>
                </div>
            </div>

            {/* ── 工具栏：只放搜索（状态筛选挪到表头，Excel 风格） ── */}
            <div className="p-download__toolbar">
                <Input
                    className="p-download__search"
                    prefix={<Search size={14} />}
                    placeholder={t('download.search_placeholder_all')}
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    allowClear
                    onClear={() => setSearchValue('')}
                />
            </div>

            {/* ── 列表 ── */}
            <div className="p-download__body" ref={tableRootRef}>
                {filteredRows.length === 0 ? (
                    <div className="p-download__empty">
                        <Download size={40} strokeWidth={1.5} />
                        <div className="p-download__empty-text">
                            {rows.length === 0
                                ? t('download.empty_all')
                                : t('download.empty_filtered')}
                        </div>
                    </div>
                ) : (
                    <DownloadTable
                        rows={filteredRows}
                        selectedIds={selectedIds}
                        onRowClick={handleRowClick}
                        onRowDoubleClick={handleRowDoubleClick}
                        onRowContextMenu={handleRowContextMenu}
                        sortOrder={sortOrder}
                        onToggleSort={() =>
                            setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                        }
                        statusFilter={
                            <HeaderFilter
                                value={statusFilter}
                                onChange={(v) => setStatusFilter(v as TDownloadStatusFilter)}
                                title={t('download.col_status')}
                                options={FILTERS.map((key) => ({
                                    value: key,
                                    label: t(`download.filter_${key}`),
                                    count: counts.get(key) ?? 0,
                                }))}
                            />
                        }
                    />
                )}
            </div>
        </div>
    );
}
