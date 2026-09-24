/**
 * cloudUpload — 渲染层「传至云盘」助手
 *
 * 职责：
 * - 把歌曲条目解析成本地上传任务（本地音乐库文件 / 已下载文件）
 * - 本地没有文件时**照旧提交**：主进程会自己向插件取音源，边下边传（不落磁盘）
 * - 统一 toast 反馈
 *
 * 说明：远端文件名由主进程按「歌名 - 歌手.ext」生成，此处只负责组装任务与找文件。
 */

import cloudDisk from '@infra/cloudDisk/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import localMusic from '@infra/localMusic/renderer';
import musicSheet from '@infra/musicSheet/renderer';
import { DOWNLOADED_SHEET_ID } from '@infra/musicSheet/common/constant';
import i18n from '@infra/i18n/renderer';
import localSource from './localSource';
import { showToast } from '../components/ui/Toast';
import { compositeKey } from '@common/mediaKey';
import type { ICloudUploadResult, ICloudUploadTask } from '@appTypes/infra/cloudDisk';

/**
 * 解析条目的本地文件路径；没有本地文件返回 null。
 *
 * 走**文件真值**索引 `localSource`（下载记录 ∪ 本地音乐库 + 存在性校验），
 * 匹配口径：主键 → 原始身份 → 作品键 → 歌名+歌手。所以「这首歌在别的插件下
 * 播放/下载过」也能找到本地文件，而删掉下载记录也不会让本地文件消失。
 */
export function resolveCloudFilePath(item: IMusic.IMusicItem): string | null {
    if (typeof item.localPath === 'string' && item.localPath) return item.localPath;
    return localSource.getEntry(item)?.path ?? null;
}

/**
 * 条目 → 上传任务。
 *
 * 找得到本地文件就带 `filePath`（读本地文件直传）；找不到就留空 ——
 * 主进程会自己取源边下边传，所以「没下载也能传云端」不需要另一个入口。
 */
function toUploadTask(item: IMusic.IMusicItem): ICloudUploadTask {
    const filePath = resolveCloudFilePath(item);
    return {
        ...(filePath ? { filePath } : {}),
        title: item.title ?? '',
        artist: item.artist ?? '',
        platform: item.platform,
        id: String(item.id),
    };
}

/** 结果 → toast 文案 */
function showUploadResult(result: ICloudUploadResult): void {
    // 全军覆没时把第一条原因带出来：从音源直传最常见的失败是「音源取不到 / 403」，
    // 只说「失败 3」用户没法判断是自己网络还是这首歌没源
    if (result.failed > 0 && result.uploaded === 0 && result.skipped === 0) {
        showToast(
            i18n.t('cloud_music.upload_failed', {
                reason: result.errors[0] ?? String(result.failed),
            }),
            { type: 'warn' },
        );
        return;
    }

    const message = i18n.t('cloud_music.upload_done', {
        uploaded: result.uploaded,
        skipped: result.skipped,
        failed: result.failed,
    });
    showToast(message, { type: result.failed > 0 ? 'warn' : 'info' });
    if (result.errors.length) {
        // 失败原因打印到控制台，便于排查（UI 只提示数量）
        console.warn('[cloudUpload] 部分文件上传失败:', result.errors);
    }
}

/** 上传一组条目（有本地文件传文件，没有的从音源直传） */
export async function uploadItemsToCloud(items: IMusic.IMusicItem[]): Promise<void> {
    const tasks: ICloudUploadTask[] = items.map(toUploadTask);
    if (!tasks.length) return;

    showToast(i18n.t('cloud_music.upload_start', { count: tasks.length }), { type: 'info' });
    try {
        // 右键入口 → manual：这些单曲会出现在「选择性恢复」的可选清单里
        const result = await cloudDisk.uploadTasks(tasks, 'manual');
        showUploadResult(result);
    } catch (err) {
        showToast(
            i18n.t('cloud_music.upload_failed', {
                reason: err instanceof Error ? err.message : String(err),
            }),
            { type: 'warn' },
        );
    }
}

/** 上传整张歌单（有文件的传文件，没文件的从音源直传） */
export async function uploadSheetToCloud(sheetId: string, sheetTitle: string): Promise<void> {
    const list = await musicSheet.getSheetMusicList(sheetId);
    const items = (list ?? []) as unknown as IMusic.IMusicItem[];
    if (!items.length) {
        showToast(i18n.t('cloud_music.upload_sheet_empty', { title: sheetTitle }), {
            type: 'warn',
        });
        return;
    }
    await uploadItemsToCloud(items);
}

/**
 * 收集「所有本地文件」的上传任务：
 * 1. 下载管理里已完成的文件（文件名走下载歌单里的标题/歌手）
 * 2. 本地音乐库扫描到的文件
 */
export async function collectAllLocalTasks(): Promise<ICloudUploadTask[]> {
    const taskMap = new Map<string, ICloudUploadTask>();

    // ── 本地音乐库（同时用于给下载记录补标题/歌手）──
    let localItems: IMusic.IMusicItem[] = [];
    try {
        localItems = (await localMusic.getAllMusicItems()) ?? [];
    } catch (err) {
        console.warn('[cloudUpload] 读取本地音乐库失败:', err);
    }
    const libraryByPath = new Map<string, IMusic.IMusicItem>();
    for (const item of localItems) {
        const filePath = resolveCloudFilePath(item);
        if (filePath) libraryByPath.set(filePath, item);
    }

    // ── 已下载 ──
    const [downloadedList, downloadedSheet] = await Promise.all([
        downloadManager.getAllDownloaded(),
        musicSheet.getSheetMusicList(DOWNLOADED_SHEET_ID).catch((): unknown[] => []),
    ]);
    const titleMap = new Map<string, IMusic.IMusicItem>();
    for (const item of (downloadedSheet ?? []) as unknown as IMusic.IMusicItem[]) {
        titleMap.set(compositeKey(item.platform, String(item.id)), item);
    }
    for (const record of downloadedList ?? []) {
        if (!record?.path) continue;
        const key = compositeKey(record.platform, String(record.musicId));
        // 优先用「已下载歌单」的标题；查不到就回退到本地音乐库里的同名文件
        const known = titleMap.get(key);
        const fromLibrary = libraryByPath.get(record.path);
        taskMap.set(record.path, {
            filePath: record.path,
            title: known?.title || fromLibrary?.title || '',
            artist: known?.artist || fromLibrary?.artist || '',
            platform: record.platform,
            id: String(record.musicId),
        });
    }

    // ── 本地音乐库里的其余文件 ──
    for (const item of localItems) {
        const filePath = resolveCloudFilePath(item);
        if (!filePath) continue;
        if (taskMap.has(filePath)) continue;
        taskMap.set(filePath, {
            filePath,
            title: item.title ?? '',
            artist: item.artist ?? '',
            platform: item.platform,
            id: String(item.id),
        });
    }

    return [...taskMap.values()];
}

/** 备份时的「同时上传本地音乐文件」入口 */
export async function uploadAllLocalFiles(): Promise<ICloudUploadResult | null> {
    const tasks = await collectAllLocalTasks();
    if (!tasks.length) {
        showToast(i18n.t('cloud_music.upload_no_local'), { type: 'warn' });
        return null;
    }
    showToast(i18n.t('cloud_music.upload_start', { count: tasks.length }), { type: 'info' });
    try {
        // 备份触发的批量上传 → auto
        const result = await cloudDisk.uploadTasks(tasks, 'auto');
        showUploadResult(result);
        return result;
    } catch (err) {
        showToast(
            i18n.t('cloud_music.upload_failed', {
                reason: err instanceof Error ? err.message : String(err),
            }),
            { type: 'warn' },
        );
        return null;
    }
}
