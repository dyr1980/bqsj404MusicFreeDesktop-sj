import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { showModal } from '../../ui/Modal/modalManager';
import i18n from '@infra/i18n/renderer';
import { Download, Search, Trash2, Upload } from 'lucide-react';
import { DeleteCloudLyricIcon, UnlinkLyricIcon, ViewLyricIcon } from '../LyricIcons';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

/** 右键菜单能触发的批量动作（真正的执行在歌词管理弹窗里） */
export type TLyricMenuAction = 'unlink' | 'upload' | 'download' | 'deleteLocal' | 'deleteCloud';

/**
 * 歌词管理行在右键菜单里需要的字段。
 *
 * 故意写成结构化的小类型（而不是 import 弹窗里的 ILyricRow / 条目类型），
 * 免得 business/contextMenus 反向依赖 modals 层。
 */
export interface ILyricMenuRow {
    key: string;
    /** 歌曲行 / 本地未匹配 / 云端未匹配 */
    kind: 'song' | 'orphan-local' | 'orphan-cloud';
    title: string;
    artist?: string;
    /** 关联目标（只有歌曲行有） */
    item?: IMusic.IMusicItem | IMusicItemSlim;
    /** 有可查看的文本来源 */
    viewable?: boolean;
    /** 已手动关联 */
    linked?: boolean;
    /** 关联的歌词文本（没缓存文本时为空） */
    linkedText?: string;
    /** 关联来源的可读描述 */
    linkedFrom?: string;
    /** 本地歌词文件路径 */
    localLyricPath?: string;
    /** 本地音频文件路径（决定「保存到本地」落在哪） */
    localAudioPath?: string;
    /** 云端歌词的逻辑名（`<歌名 - 歌手>.lrc`） */
    cloudName?: string;
    /** 云端歌词的远端路径 */
    cloudRemotePath?: string;
    /** 本地有可上传的文本（本地 .lrc 或已关联文本） */
    uploadable?: boolean;
    /** 云端有、本地没有 → 可保存到本地 */
    downloadable?: boolean;
}

export interface LyricRowMenuContext {
    /** 本次右键命中的行（点中的行已在选区里 → 整个选区） */
    rows: ILyricMenuRow[];
    /** 查看歌词（弹窗自己切到只读面板） */
    onView: (row: ILyricMenuRow) => void;
    /** 批量动作交给弹窗执行（它持有读取 / 写入 / 刷新逻辑） */
    onAction: (action: TLyricMenuAction, rows: ILyricMenuRow[]) => void;
}

/**
 * LyricRowMenu — 歌词管理的行右键菜单
 *
 * 和下载管理一致：选中只有整行高亮，没有勾选框、没有底部操作条，
 * 批量操作（取消关联 / 上传到云端 / 保存到本地 / 删除本地歌词 / 删除云端歌词）
 * 全部进右键菜单。
 *
 * 弹窗自己会订阅云端内容变化与关联记录变化，所以这里只负责「发起」，
 * 不需要回传结果刷新列表（本地歌词的增删由弹窗的 onAction 内部补一次刷新）。
 */
export function LyricRowMenu({ rows, onView, onAction }: LyricRowMenuContext): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [];
    if (!rows.length) return entries;

    const t = i18n.t.bind(i18n);
    const single = rows.length === 1 ? rows[0] : null;

    // ── 单个：查看 / 关联 ──
    if (single && single.viewable) {
        entries.push({
            id: 'lyric-view',
            icon: <ViewLyricIcon />,
            label: t('lyric.manage.action_view'),
            onClick: () => onView(single),
        });
    }

    if (single && single.kind === 'song' && single.item) {
        entries.push({
            id: 'lyric-link',
            icon: <Search />,
            label: t('lyric.manage.action_link'),
            onClick: () => showModal('SearchLyricModal', { musicItem: single.item }),
        });
    }

    const linked = rows.filter((row) => row.linked);
    const uploadable = rows.filter((row) => row.uploadable);
    const downloadable = rows.filter((row) => row.downloadable);
    const localFiles = rows.filter((row) => row.localLyricPath);
    const cloudFiles = rows.filter((row) => row.cloudRemotePath);

    if (entries.length) entries.push({ type: 'separator' });

    if (linked.length) {
        entries.push({
            id: 'lyric-unlink',
            icon: <UnlinkLyricIcon />,
            label: t('lyric.manage.bulk_unlink', { count: linked.length }),
            onClick: () => onAction('unlink', linked),
        });
    }

    if (uploadable.length) {
        entries.push({
            id: 'lyric-upload',
            icon: <Upload size={15} />,
            label: t('lyric.manage.bulk_upload', { count: uploadable.length }),
            onClick: () => onAction('upload', uploadable),
        });
    }

    if (downloadable.length) {
        entries.push({
            id: 'lyric-download',
            icon: <Download size={15} />,
            label: t('lyric.manage.bulk_download', { count: downloadable.length }),
            onClick: () => onAction('download', downloadable),
        });
    }

    if (localFiles.length || cloudFiles.length) {
        if (entries.length) entries.push({ type: 'separator' });
    }

    if (localFiles.length) {
        entries.push({
            id: 'lyric-delete-local',
            icon: <Trash2 size={15} />,
            label: t('lyric.manage.bulk_delete_local', { count: localFiles.length }),
            danger: true,
            onClick: () => onAction('deleteLocal', localFiles),
        });
    }

    if (cloudFiles.length) {
        entries.push({
            id: 'lyric-delete-cloud',
            icon: <DeleteCloudLyricIcon />,
            label: t('lyric.manage.bulk_delete_cloud', { count: cloudFiles.length }),
            danger: true,
            onClick: () => onAction('deleteCloud', cloudFiles),
        });
    }

    return entries;
}
