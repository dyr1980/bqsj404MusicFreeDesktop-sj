import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Search, FileMusic } from 'lucide-react';
import { RequestStatus } from '@common/constant';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { SongTable } from '../../components/business/SongTable';
import { FavoriteButton } from '../../components/business/FavoriteButton';
import { DownloadButton } from '../../components/business/DownloadButton';
import { CloudButton } from '../../components/business/CloudButton';
import { StatusPlaceholder } from '../../components/ui/StatusPlaceholder';
import { showModal } from '../../components/ui/Modal/modalManager';
import { showContextMenu } from '../../components/ui/ContextMenu/contextMenuManager';
import { useSelection } from '../../hooks/useSelection';
import cloudDisk from '@infra/cloudDisk/renderer';
import type { ICloudStatus } from '@appTypes/infra/cloudDisk';
import type { HideableColumn } from '../../components/business/SongTable';
import './index.scss';

// ─── Constants ───

const HIDE_COLUMNS: HideableColumn[] = ['platform'];

/**
 * CloudMusicPage — 云盘音乐页面
 *
 * 路由: /cloud-music
 *
 * 功能：
 *   - 列出远端 /MusicFree/music 下的音频文件（文件名约定：歌名 - 歌手.ext）
 *   - 双击/播放按钮直接播放（主进程生成带鉴权的本地转发地址，支持 Range 拖动）
 *   - 未配置 WebDAV 或连接失败时给出明确提示
 */
export default function CloudMusicPage() {
    const { t } = useTranslation();

    const [items, setItems] = useState<IMusic.IMusicItem[]>([]);
    const [status, setStatus] = useState<ICloudStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [searchValue, setSearchValue] = useState('');
    const [uploading, setUploading] = useState<{
        current: number;
        total: number;
        name: string;
    } | null>(null);
    const deferredSearch = useDeferredValue(searchValue);

    const load = useCallback(async (force: boolean) => {
        setLoading(true);
        setErrorMsg('');
        try {
            const list = await cloudDisk.getAllItems(force);
            setItems(list);
        } catch (err) {
            setItems([]);
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setStatus(await cloudDisk.getStatus());
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // 强制拉取一次：在网盘网页端手动增删文件后，进来就能看到最新内容
        void load(true);

        const offFiles = cloudDisk.onFilesChanged(() => {
            // 上传结束/远端变化：清掉进度并按新内容刷新
            setUploading(null);
            void load(true);
        });

        const offProgress = cloudDisk.onUploadProgress((progress) => {
            setUploading(progress);
        });

        return () => {
            offFiles();
            offProgress();
        };
    }, [load]);

    useEffect(() => {
        // 页面已经挂载、但云盘内容在别处变了（网盘网页端、另一个窗口、本地抓的文件移进移出）
        // 时不会自动刷新，看起来就像「看不到数据」。窗口重新获得焦点时补拉一次。
        const onFocus = () => {
            if (document.visibilityState !== 'visible') return;
            void load(true);
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [load]);

    const filteredItems = useMemo(() => {
        const keyword = deferredSearch.trim().toLowerCase();
        if (!keyword) return items;
        return items.filter(
            (item) =>
                item.title.toLowerCase().includes(keyword) ||
                (item.artist ?? '').toLowerCase().includes(keyword) ||
                String(item.cloudName ?? '')
                    .toLowerCase()
                    .includes(keyword),
        );
    }, [items, deferredSearch]);

    // ── 多选（Ctrl/Shift 点选、Ctrl+A 全选，语义见 core/selection） ──
    const { selectionProps } = useSelection([deferredSearch]);

    /** 右键菜单：云端条目本身 platform 就是「云端」，直接交给通用单曲菜单 */
    const handleRowContextMenu = useCallback(
        ({ selectedItems }: { selectedItems: IMusic.IMusicItemBase[] }, e: React.MouseEvent) => {
            showContextMenu(
                'MusicItemMenu',
                { x: e.clientX, y: e.clientY },
                {
                    musicItems: selectedItems as IMusic.IMusicItem[],
                },
            );
        },
        [],
    );

    const notConfigured = status !== null && !status.configured;
    const isEmpty = !loading && items.length === 0;

    let emptyTitle = t('cloud_music.empty_title');
    let emptyDesc = t('cloud_music.empty_desc');
    if (notConfigured) {
        emptyTitle = t('cloud_music.not_configured_title');
        emptyDesc = t('cloud_music.not_configured_desc');
    } else if (errorMsg) {
        emptyTitle = t('cloud_music.connect_failed');
        emptyDesc = errorMsg;
    }

    return (
        <div className="p-cloud-music">
            {/* ── 页头 ── */}
            <div className="p-cloud-music__header">
                <div className="p-cloud-music__title-row">
                    <h2 className="p-cloud-music__title">{t('cloud_music.title')}</h2>
                    {/* 目录跟在标题后面：贴在「歌词管理」左边时，会被当成歌词目录 */}
                    {status?.musicDir && (
                        <span
                            className="p-cloud-music__dir"
                            title={t('cloud_music.music_dir_hint')}
                        >
                            {status.musicDir}
                        </span>
                    )}
                    {items.length > 0 && (
                        <span className="p-cloud-music__count">
                            {t('cloud_music.song_count', { count: items.length })}
                        </span>
                    )}
                    {loading && <RefreshCw size={18} className="p-cloud-music__spin" />}
                    {uploading && (
                        <span className="p-cloud-music__uploading">
                            {t('cloud_music.uploading', {
                                current: uploading.current,
                                total: uploading.total,
                            })}
                        </span>
                    )}
                </div>
                <div className="p-cloud-music__header-actions">
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<FileMusic size={16} />}
                        onClick={() => showModal('LyricManagerModal', { scope: 'cloud' })}
                    >
                        {t('lyric.manage.open')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<RefreshCw size={16} />}
                        onClick={() => void load(true)}
                    >
                        {t('cloud_music.refresh')}
                    </Button>
                </div>
            </div>

            {/* ── 搜索 ── */}
            <div className="p-cloud-music__toolbar">
                <Input
                    className="p-cloud-music__search"
                    prefix={<Search size={14} />}
                    placeholder={t('cloud_music.search_placeholder')}
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    allowClear
                    onClear={() => setSearchValue('')}
                />
            </div>

            {/* ── 列表 ── */}
            <div className="p-cloud-music__body">
                {isEmpty ? (
                    <StatusPlaceholder
                        status={loading ? RequestStatus.Pending : RequestStatus.Done}
                        isEmpty={isEmpty}
                        emptyTitle={emptyTitle}
                        emptyDescription={emptyDesc}
                    />
                ) : (
                    <SongTable
                        data={filteredItems}
                        requestStatus={RequestStatus.Done}
                        hideColumns={HIDE_COLUMNS}
                        {...selectionProps}
                        onRowContextMenu={handleRowContextMenu}
                        statusColumn={(item) => (
                            <>
                                <FavoriteButton musicItem={item} size="sm" />
                                <DownloadButton musicItem={item} size="sm" />
                                <CloudButton musicItem={item} size="sm" />
                            </>
                        )}
                    />
                )}
            </div>
        </div>
    );
}
