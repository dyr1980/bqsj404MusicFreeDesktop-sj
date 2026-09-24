/**
 * localMusic — 主进程层
 *
 * 职责：
 * - 扫描文件夹管理（增删改查）
 * - 增量扫描（文件发现 → diff → metadata 解析 → DB 写入）
 * - IPC 注册（handle + broadcast）
 * - local_music → IMusicItem 转换（含 folder 字段，供渲染进程客户端聚合）
 * - 启动后 60s 空闲静默 rescan
 */

import { ipcMain, shell } from 'electron';
import { nanoid } from 'nanoid';
import fsp from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import type { IDbCompat, IDbStatement, IDatabaseProvider } from '@appTypes/infra/database';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type { IAppConfigReader } from '@appTypes/infra/appConfig';
import type {
    ILocalMusicItem,
    ILocalLyricItem,
    ILocalFileQuery,
    ILocalFileLookup,
    IScanFolder,
    IScanProgress,
    IScanResult,
    IFileInfo,
} from '@appTypes/infra/localMusic';
import type { IMediaMetaProvider } from '@appTypes/infra/mediaMeta';
import { LOCAL_PLUGIN_NAME, INTERNAL_SLIM_KEY } from '@common/constant';
import { buildMediaNameKey, normalizeArtistKey, normalizeTitleKey } from '@common/mediaNameKey';
import { pathToFileURL } from 'url';
import { IPC, SCAN_BATCH_SIZE } from '../common/constant';
import { discoverFiles, diffWithDb } from './scanner';
import { parseFileMetadata } from './metadataParser';

// ─── Prepared Statements ───

interface ILocalMusicQueries {
    getAllScanFolders: IDbStatement;
    insertScanFolder: IDbStatement;
    deleteScanFolder: IDbStatement;
    updateScanFolderLastScan: IDbStatement;

    upsertLocalMusic: IDbStatement;
    deleteLocalMusic: IDbStatement;
    deleteLocalMusicByScanFolder: IDbStatement;
    deleteLocalMusicByKey: IDbStatement;
    getFilePathByMusicKey: IDbStatement;
    getLocalMusicByScanFolder: IDbStatement;

    getAllMusic: IDbStatement;

    /** 下载记录对应的原曲条目（补齐 ID3 里缺失的歌名/歌手） */
    getMusicItemMeta: IDbStatement;

    // ─── 文件真值查询（v11 起：「本地有没有文件」的唯一权威） ───
    getFileByMusicKey: IDbStatement;
    getFileByWorkKey: IDbStatement;
    getAllFilesForLookup: IDbStatement;
    getMusicItemByWorkKey: IDbStatement;
    upsertDownloadedFile: IDbStatement;

    // ─── 歌词文件 ───
    upsertLocalLyric: IDbStatement;
    updateLocalLyricAudio: IDbStatement;
    deleteLocalLyric: IDbStatement;
    deleteLocalLyricByScanFolder: IDbStatement;
    getLocalLyricByScanFolder: IDbStatement;
    getAllLyrics: IDbStatement;
}

/** 歌词文件名 → 歌名/歌手（`<歌名> - <歌手>` 时拆开，否则整名当歌名） */
function parseLyricFileName(fileName: string): { title: string; artist: string } {
    // 歌名本身可能含 ` - `，取最后一个分隔符（与云盘文件名解析同规则）
    const idx = fileName.lastIndexOf(' - ');
    if (idx > 0) {
        return {
            title: fileName.slice(0, idx).trim(),
            artist: fileName.slice(idx + 3).trim(),
        };
    }
    return { title: fileName.trim(), artist: '' };
}

/** 去掉扩展名的路径（用于「歌词 ↔ 音频」同名配对，大小写作键） */
function baseKeyWithoutExt(filePath: string): string {
    return filePath.replace(/\.[^.\\/]+$/, '').toLowerCase();
}

function createQueries(db: IDbCompat): ILocalMusicQueries {
    return {
        // ─── scan_folders ───
        getAllScanFolders: db.prepare(
            'SELECT id, folder_path AS folderPath, last_scan_at AS lastScanAt, created_at AS createdAt FROM scan_folders ORDER BY created_at ASC',
        ),
        insertScanFolder: db.prepare(
            'INSERT INTO scan_folders (id, folder_path, created_at) VALUES (@id, @folderPath, @createdAt)',
        ),
        deleteScanFolder: db.prepare('DELETE FROM scan_folders WHERE id = ?'),
        updateScanFolderLastScan: db.prepare(
            'UPDATE scan_folders SET last_scan_at = @lastScanAt WHERE id = @id',
        ),

        // ─── local_music CRUD ───
        upsertLocalMusic: db.prepare(`
            INSERT INTO local_music
                (file_path, platform, music_id, title, artist, album, duration, artwork,
                 folder, file_size, file_mtime, scan_folder_id, created_at, work_key, quality, source)
            VALUES
                (@filePath, @platform, @id, @title, @artist, @album, @duration, @artwork,
                 @folder, @fileSize, @fileMtime, @scanFolderId, @createdAt, @workKey, @quality, @source)
            ON CONFLICT(file_path) DO UPDATE SET
                platform = excluded.platform,
                music_id = excluded.music_id,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                duration = excluded.duration,
                artwork = COALESCE(excluded.artwork, artwork),
                folder = excluded.folder,
                file_size = excluded.file_size,
                file_mtime = excluded.file_mtime,
                scan_folder_id = excluded.scan_folder_id,
                work_key = COALESCE(excluded.work_key, local_music.work_key),
                -- 扫描不带音质信息，别把「下载登记」写下的音质冲掉
                quality = COALESCE(excluded.quality, local_music.quality)
        `),
        deleteLocalMusic: db.prepare('DELETE FROM local_music WHERE file_path = ?'),
        deleteLocalMusicByScanFolder: db.prepare(
            'DELETE FROM local_music WHERE scan_folder_id = ?',
        ),
        deleteLocalMusicByKey: db.prepare(
            'DELETE FROM local_music WHERE platform = ? AND music_id = ?',
        ),
        getFilePathByMusicKey: db.prepare(
            'SELECT file_path AS filePath FROM local_music WHERE platform = ? AND music_id = ?',
        ),
        getLocalMusicByScanFolder: db.prepare(
            'SELECT file_path, file_size, file_mtime FROM local_music WHERE scan_folder_id = ?',
        ),

        // ─── 文件真值查询（取源 / 歌词 / 传云端共用） ───
        getFileByMusicKey: db.prepare(`
            SELECT file_path AS filePath, platform, music_id AS id, quality
            FROM local_music WHERE platform = ? AND music_id = ? LIMIT 1
        `),
        getFileByWorkKey: db.prepare(`
            SELECT file_path AS filePath, platform, music_id AS id, quality
            FROM local_music WHERE work_key = ? LIMIT 1
        `),
        getAllFilesForLookup: db.prepare(`
            SELECT file_path AS filePath, platform, music_id AS id, title, artist,
                   quality, work_key AS workKey
            FROM local_music
        `),
        getMusicItemByWorkKey: db.prepare(`
            SELECT platform, id FROM music_items
            WHERE work_key = ? AND platform <> ? LIMIT 1
        `),
        /** 下载完成后「登记文件」：文件进文件真值层，来源标 download */
        upsertDownloadedFile: db.prepare(`
            INSERT INTO local_music
                (file_path, platform, music_id, title, artist, album, duration, artwork,
                 folder, file_size, file_mtime, scan_folder_id, created_at, work_key, quality, source)
            VALUES
                (@filePath, @platform, @id, @title, @artist, '', NULL, NULL,
                 @folder, @fileSize, @fileMtime, '', @createdAt, @workKey, @quality, 'download')
            ON CONFLICT(file_path) DO UPDATE SET
                platform = excluded.platform,
                music_id = excluded.music_id,
                title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE local_music.title END,
                artist = CASE WHEN excluded.artist <> '' THEN excluded.artist ELSE local_music.artist END,
                work_key = COALESCE(excluded.work_key, local_music.work_key),
                quality = COALESCE(excluded.quality, local_music.quality),
                source = 'download'
        `),

        // ─── 全量查歌曲列表 ───
        getAllMusic: db.prepare(`
            SELECT file_path AS filePath, platform, music_id AS id, title, artist, album,
                   duration, artwork, folder, file_size AS fileSize, file_mtime AS fileMtime,
                   scan_folder_id AS scanFolderId, created_at AS createdAt
            FROM local_music ORDER BY title
        `),

        /** 下载记录对应的原曲条目（本地文件 ID3 缺歌名/歌手时用它补齐） */
        getMusicItemMeta: db.prepare(
            'SELECT title, artist FROM music_items WHERE platform = ? AND id = ?',
        ),

        // ─── 歌词文件 ───
        upsertLocalLyric: db.prepare(`
            INSERT INTO local_lyric
                (file_path, file_name, title, artist, audio_path, file_size, file_mtime,
                 scan_folder_id, created_at)
            VALUES
                (@filePath, @fileName, @title, @artist, @audioPath, @fileSize, @fileMtime,
                 @scanFolderId, @createdAt)
            ON CONFLICT(file_path) DO UPDATE SET
                file_name = excluded.file_name,
                title = excluded.title,
                artist = excluded.artist,
                audio_path = excluded.audio_path,
                file_size = excluded.file_size,
                file_mtime = excluded.file_mtime,
                scan_folder_id = excluded.scan_folder_id
        `),
        updateLocalLyricAudio: db.prepare(
            'UPDATE local_lyric SET audio_path = @audioPath WHERE file_path = @filePath',
        ),
        deleteLocalLyric: db.prepare('DELETE FROM local_lyric WHERE file_path = ?'),
        deleteLocalLyricByScanFolder: db.prepare(
            'DELETE FROM local_lyric WHERE scan_folder_id = ?',
        ),
        getLocalLyricByScanFolder: db.prepare(
            'SELECT file_path, file_size, file_mtime, audio_path FROM local_lyric WHERE scan_folder_id = ?',
        ),
        getAllLyrics: db.prepare(`
            SELECT file_path AS filePath, file_name AS fileName, title, artist,
                   audio_path AS audioPath, file_size AS fileSize, file_mtime AS fileMtime,
                   scan_folder_id AS scanFolderId, created_at AS createdAt
            FROM local_lyric ORDER BY file_name
        `),
    };
}

// ─── LocalMusicManager ───

class LocalMusicManager {
    private isSetup = false;
    private db!: IDatabaseProvider;
    private windowManager!: IWindowManager;
    private appConfig!: IAppConfigReader;
    private mediaMeta!: IMediaMetaProvider;
    private queries!: ILocalMusicQueries;
    private isScanning = false;
    private cancelledFolderIds = new Set<string>();
    private scanQueue: Array<{
        scanFolderId: string;
        folderPath: string;
        callbacks: Array<{
            resolve: (result: IScanResult) => void;
            reject: (error: unknown) => void;
        }>;
    }> = [];

    public setup(deps: {
        db: IDatabaseProvider;
        windowManager: IWindowManager;
        appConfig: IAppConfigReader;
        mediaMeta: IMediaMetaProvider;
    }) {
        if (this.isSetup) return;
        this.db = deps.db;
        this.windowManager = deps.windowManager;
        this.appConfig = deps.appConfig;
        this.mediaMeta = deps.mediaMeta;

        const db = deps.db.getDatabase();
        this.queries = createQueries(db);

        this.registerIpcHandlers();

        // 启动后 60s 空闲静默 rescan
        setTimeout(() => {
            this.idleRescan();
        }, 60_000);

        this.isSetup = true;
    }

    /**
     * 按文件路径清掉本地音乐库里的记录（文件已被别的流程删掉时调用）。
     *
     * 下载管理的「连本地文件一起删」走的是 `fsp.unlink`，不会触发目录扫描；
     * 不同步删记录的话，那条歌会一直留在「本地音乐」列表里（双击也放不出来）。
     */
    public removeFileRecord(filePath: string): void {
        if (!filePath) return;
        this.queries.deleteLocalMusic.run(filePath);
        this.queries.deleteLocalLyric.run(filePath);
        this.broadcastLibraryChanged();
    }

    /**
     * 查「这首歌本地有没有文件」——**文件真值**口径，主进程侧统一入口。
     *
     * 候选只来自文件真值层（`local_music`），下载记录不参与判断：记录只说明
     * 「什么时候下载过、什么音质」，文件被删/记录被清都不该改变「本地有这份文件」这个事实。
     * 匹配顺序与渲染层 `core/localSource` 一致：
     * 主键 → 原始身份 → 作品键 → 歌名+歌手 → （歌手未知时）歌名唯一兜底。
     * 命中后还会 stat 一次，文件真的在才返回。
     *
     * 消费方：歌词取源（`getLyricAdapter`）、下载判定 / 删除文件（downloadManager）。
     *
     * @returns 命中时的文件路径与登记音质；没有文件返回 null
     */
    public async lookupFile(query: ILocalFileQuery): Promise<ILocalFileLookup | null> {
        if (!query?.platform || query.id === undefined || query.id === null) return null;

        const pick = (row?: { filePath?: string; quality?: string | null } | null) =>
            row?.filePath
                ? {
                      path: row.filePath,
                      quality: (row.quality ?? null) as IMusic.IQualityKey | null,
                  }
                : null;

        // 1) 主键（platform + id）
        let hit = pick(
            this.queries.getFileByMusicKey.get(query.platform, String(query.id)) as
                | { filePath?: string; quality?: string | null }
                | undefined,
        );

        // 2) 原始身份（「切到本地/云盘」后 platform 被改写，原身份仍要能查到）
        if (!hit && query.originPlatform && query.originId) {
            hit = pick(
                this.queries.getFileByMusicKey.get(query.originPlatform, String(query.originId)) as
                    | { filePath?: string; quality?: string | null }
                    | undefined,
            );
        }

        // 3) 作品键（跨插件同一首歌）
        const workKey = buildMediaNameKey(query.title, query.artist);
        if (!hit && workKey) {
            hit = pick(
                this.queries.getFileByWorkKey.get(workKey) as
                    | { filePath?: string; quality?: string | null }
                    | undefined,
            );
        }

        // 4) 歌名 + 歌手；5) 歌手未知/为空且歌名唯一时认那一份
        if (!hit && query.title) {
            const rows = this.queries.getAllFilesForLookup.all() as Array<{
                filePath: string;
                title: string | null;
                artist: string | null;
                quality: string | null;
            }>;
            const titleKey = normalizeTitleKey(query.title);
            const artistKey = normalizeArtistKey(query.artist);
            if (titleKey) {
                const sameTitle = rows.filter((r) => normalizeTitleKey(r.title) === titleKey);
                const byName = artistKey
                    ? sameTitle.find((r) => normalizeArtistKey(r.artist) === artistKey)
                    : sameTitle.length === 1
                      ? sameTitle[0]
                      : undefined;
                if (byName) hit = pick(byName);
            }
        }

        if (!hit) return null;

        // 文件真的在才算命中（外部删文件不会发事件，这里兜一层）
        try {
            await fsp.stat(hit.path);
        } catch {
            return null;
        }
        return hit;
    }

    /**
     * 把刚下载好的文件「登记」进文件真值层。
     *
     * 下载目录不一定是扫描目录，不登记的话这份文件只能靠下载记录被间接找到；
     * 登记后它就是本地音乐库里的一份文件（`source = 'download'`），取源/歌词/
     * 传云端都按文件真值命中，删掉下载记录也不影响。
     *
     * @param quality 下载时的音质（未知传 null），仅用于音质匹配与展示
     */
    public registerDownloadedFile(params: {
        filePath: string;
        platform: string;
        id: string;
        title?: string;
        artist?: string;
        quality?: IMusic.IQualityKey | null;
    }): void {
        if (!params?.filePath) return;

        let fileSize: number | null = null;
        let fileMtime = Date.now();
        try {
            const stat = statSync(params.filePath);
            fileSize = stat.size;
            fileMtime = Math.floor(stat.mtimeMs);
        } catch {
            // 文件还没落盘也先登记，下次扫描会补上大小/时间
        }

        try {
            this.queries.upsertDownloadedFile.run({
                filePath: params.filePath,
                platform: params.platform,
                id: String(params.id),
                title: params.title ?? '',
                artist: params.artist ?? '',
                folder: path.dirname(params.filePath),
                fileSize,
                fileMtime,
                createdAt: Date.now(),
                workKey: buildMediaNameKey(params.title, params.artist) || null,
                quality: params.quality ?? null,
            });
            this.broadcastLibraryChanged();
        } catch (err) {
            console.warn('[localMusic] 登记下载文件失败:', err);
        }
    }

    /**
     * 按作品键找「已知条目身份」，供扫描入库时解析文件身份。
     *
     * 顺序：已有本地行（同作品别的文件）→ `music_items` 条目 → `media_meta` 记录。
     * **不查下载记录**：身份来自「这个作品在库里出现过」，而不是「下载过」。
     */
    private findIdentityByWorkKey(workKey: string): { platform: string; id: string } | null {
        if (!workKey) return null;

        const local = this.queries.getFileByWorkKey.get(workKey) as
            | { platform: string; id: string }
            | undefined;
        if (local?.platform) return { platform: local.platform, id: String(local.id) };

        const item = this.queries.getMusicItemByWorkKey.get(workKey, LOCAL_PLUGIN_NAME) as
            | { platform: string; id: string }
            | undefined;
        if (item?.platform) return { platform: item.platform, id: String(item.id) };

        const meta = this.mediaMeta.findIdentityByWorkKey(workKey);
        if (meta?.platform) return { platform: meta.platform, id: String(meta.musicId) };

        return null;
    }

    private registerIpcHandlers() {
        // ─── 扫描文件夹管理 ───

        ipcMain.handle(IPC.GET_SCAN_FOLDERS, (): IScanFolder[] => {
            return this.queries.getAllScanFolders.all() as IScanFolder[];
        });

        ipcMain.handle(
            IPC.SYNC_SCAN_FOLDERS,
            async (_evt, folderPaths: string[]): Promise<IScanResult> => {
                // 1. 规范化输入路径，并以 lowercase 作为比较键（Windows 不区分大小写）
                const inputNormalized = folderPaths.map((fp) => path.normalize(fp));
                const inputSet = new Map(inputNormalized.map((fp) => [fp.toLowerCase(), fp]));

                // 2. 读取 DB 当前状态
                const dbFolders = this.queries.getAllScanFolders.all() as IScanFolder[];
                const dbMap = new Map(
                    dbFolders.map((f) => [path.normalize(f.folderPath).toLowerCase(), f]),
                );

                // 3. 计算 diff
                const toAdd: string[] = [];
                for (const [key, fp] of inputSet) {
                    if (!dbMap.has(key)) {
                        toAdd.push(fp);
                    }
                }
                const toRemove: IScanFolder[] = [];
                for (const [key, folder] of dbMap) {
                    if (!inputSet.has(key)) {
                        toRemove.push(folder);
                    }
                }

                // 4. 原子提交 DB 增删
                const db = this.db.getDatabase();

                db.transaction(() => {
                    // 删除
                    for (const folder of toRemove) {
                        // 取消队列中的待扫描请求
                        const queueIdx = this.scanQueue.findIndex(
                            (q) => q.scanFolderId === folder.id,
                        );
                        if (queueIdx !== -1) {
                            const removed = this.scanQueue.splice(queueIdx, 1)[0];
                            const cancelResult: IScanResult = {
                                added: 0,
                                updated: 0,
                                removed: 0,
                                unchanged: 0,
                                lyrics: 0,
                                elapsed: 0,
                            };
                            removed.callbacks.forEach((cb) => cb.resolve(cancelResult));
                        } else {
                            this.cancelledFolderIds.add(folder.id);
                        }
                        this.queries.deleteLocalMusicByScanFolder.run(folder.id);
                        this.queries.deleteLocalLyricByScanFolder.run(folder.id);
                        this.queries.deleteScanFolder.run(folder.id);
                    }
                    // 新增
                    for (const fp of toAdd) {
                        const id = nanoid();
                        this.queries.insertScanFolder.run({
                            id,
                            folderPath: fp,
                            createdAt: Date.now(),
                        });
                    }
                })();

                // 5. 扫描全部最终文件夹（新增 + 保留）
                const finalFolders = this.queries.getAllScanFolders.all() as IScanFolder[];
                const totalResult: IScanResult = {
                    added: 0,
                    updated: 0,
                    removed: 0,
                    unchanged: 0,
                    lyrics: 0,
                    elapsed: 0,
                };

                for (const folder of finalFolders) {
                    const result = await this.enqueueScan(folder.id, folder.folderPath);
                    totalResult.added += result.added;
                    totalResult.updated += result.updated;
                    totalResult.removed += result.removed;
                    totalResult.unchanged += result.unchanged;
                    totalResult.lyrics += result.lyrics;
                    totalResult.elapsed += result.elapsed;
                    this.queries.updateScanFolderLastScan.run({
                        id: folder.id,
                        lastScanAt: Date.now(),
                    });
                }

                this.broadcastLibraryChanged();
                return totalResult;
            },
        );

        // ─── 获取全量 IMusicItem[]（Preload 缓存用） ───

        ipcMain.handle(IPC.GET_ALL_MUSIC_ITEMS, (): IMusic.IMusicItem[] => {
            const rows = this.queries.getAllMusic.all() as ILocalMusicItem[];
            return this.toMusicItems(rows);
        });

        ipcMain.handle(IPC.GET_ALL_LOCAL_LYRICS, (): ILocalLyricItem[] => {
            const rows = this.queries.getAllLyrics.all() as Array<Omit<ILocalLyricItem, 'folder'>>;
            // folder 不单独存列，从路径推出来（展示用）
            return rows.map((row) => ({
                ...row,
                folder: path.dirname(row.filePath),
            }));
        });

        ipcMain.handle(
            IPC.DELETE_ITEMS,
            async (_evt, musicBases: IMedia.IMediaBase[]): Promise<void> => {
                // 1. 查找对应的文件路径并移至回收站
                for (const base of musicBases) {
                    const row = this.queries.getFilePathByMusicKey.get(
                        base.platform,
                        String(base.id),
                    ) as { filePath: string } | undefined;
                    if (row?.filePath) {
                        try {
                            await shell.trashItem(row.filePath);
                        } catch {
                            // 文件可能已不存在，忽略
                        }
                    }
                }

                // 2. 删除 DB 记录
                const db = this.db.getDatabase();
                db.transaction(() => {
                    for (const base of musicBases) {
                        this.queries.deleteLocalMusicByKey.run(base.platform, String(base.id));
                    }
                })();

                this.broadcastLibraryChanged();
            },
        );
    }

    // ─── 扫描队列 ───

    /**
     * 将扫描请求加入队列。
     * 保证全局同一时刻最多只有一个 scanFolder 在执行。
     */
    private enqueueScan(scanFolderId: string, folderPath: string): Promise<IScanResult> {
        return new Promise<IScanResult>((resolve, reject) => {
            const pending = this.scanQueue.find((q) => q.scanFolderId === scanFolderId);
            if (pending) {
                pending.callbacks.push({ resolve, reject });
                return;
            }
            this.scanQueue.push({
                scanFolderId,
                folderPath,
                callbacks: [{ resolve, reject }],
            });
            this.drainQueue();
        });
    }

    private drainQueue() {
        if (this.isScanning || this.scanQueue.length === 0) {
            if (!this.isScanning && this.scanQueue.length === 0) {
                this.broadcastProgress({ phase: 'done', scanned: 0, total: 0 });
            }
            return;
        }
        const next = this.scanQueue.shift()!;
        this.scanFolder(next.scanFolderId, next.folderPath)
            .then(
                (result) => next.callbacks.forEach((cb) => cb.resolve(result)),
                (error) => next.callbacks.forEach((cb) => cb.reject(error)),
            )
            .finally(() => {
                this.drainQueue();
            });
    }

    // ─── 核心：增量扫描 ───

    private async scanFolder(scanFolderId: string, folderPath: string): Promise<IScanResult> {
        this.isScanning = true;
        const startTime = Date.now();

        const excludedPaths = this.appConfig.getConfigByKey('localMusic.excludedPaths') ?? [];

        try {
            // Phase 1: 发现文件
            this.broadcastProgress({
                phase: 'discovering',
                scanned: 0,
                total: 0,
            });
            const diskFiles = await discoverFiles(folderPath, excludedPaths);
            const diskAudios = diskFiles.audios;

            // 音频「去扩展名路径 → 实际路径」映射，用来给歌词文件配对同名音频
            const audioByBase = new Map<string, string>();
            for (const audio of diskAudios) {
                audioByBase.set(baseKeyWithoutExt(audio.filePath), audio.filePath);
            }

            // Phase 2: 增量 diff
            this.broadcastProgress({
                phase: 'diffing',
                scanned: 0,
                total: diskAudios.length,
            });
            const dbRows = this.queries.getLocalMusicByScanFolder.all(scanFolderId) as Array<{
                file_path: string;
                file_size: number | null;
                file_mtime: number | null;
            }>;
            const diff = diffWithDb(diskAudios, dbRows);

            // Phase 3: 解析新增/变更文件的 metadata
            const toProcess = [...diff.added, ...diff.changed];
            const db = this.db.getDatabase();

            for (let i = 0; i < toProcess.length; i += SCAN_BATCH_SIZE) {
                const batch = toProcess.slice(i, i + SCAN_BATCH_SIZE);
                const items: ILocalMusicItem[] = [];

                for (const file of batch) {
                    try {
                        const item = await parseFileMetadata(
                            file.filePath,
                            file.size,
                            file.mtime,
                            scanFolderId,
                            {
                                // 身份按作品键解析（不再依赖下载记录反查）
                                findIdentityByWorkKey: (workKey) =>
                                    this.findIdentityByWorkKey(workKey),
                                lookupMusicItem: (platform, id) =>
                                    (this.queries.getMusicItemMeta.get(platform, String(id)) as
                                        | { title?: string | null; artist?: string | null }
                                        | undefined) ?? null,
                            },
                        );
                        items.push(item);
                    } catch {
                        /* 跳过解析失败的文件 */
                    }
                }

                // 批量写入 DB（事务）
                if (items.length > 0 && !this.cancelledFolderIds.has(scanFolderId)) {
                    db.transaction(() => {
                        for (const item of items) {
                            this.queries.upsertLocalMusic.run({
                                filePath: item.filePath,
                                platform: item.platform,
                                id: item.id,
                                title: item.title,
                                artist: item.artist,
                                album: item.album,
                                duration: item.duration,
                                artwork: item.artwork,
                                folder: item.folder,
                                fileSize: item.fileSize,
                                fileMtime: item.fileMtime,
                                scanFolderId: item.scanFolderId,
                                createdAt: item.createdAt,
                                // 作品键：本地文件也要能被「换个插件播同一首歌」认出来
                                workKey: buildMediaNameKey(item.title, item.artist) || null,
                                // 扫描不产生音质信息（quality 保留下载登记那次的）
                                quality: null,
                                source: item.source ?? 'scan',
                            });
                        }
                    })();
                }

                this.broadcastProgress({
                    phase: 'parsing',
                    scanned: Math.min(i + SCAN_BATCH_SIZE, toProcess.length),
                    total: toProcess.length,
                    current: batch[batch.length - 1]?.filePath,
                });

                // 让出事件循环
                await new Promise((resolve) => setImmediate(resolve));
            }

            // Phase 4: 删除已不存在的文件
            if (diff.removed.length > 0 && !this.cancelledFolderIds.has(scanFolderId)) {
                db.transaction(() => {
                    for (const fp of diff.removed) {
                        this.queries.deleteLocalMusic.run(fp);
                    }
                })();
            }

            // Phase 5: 歌词文件（.lrc）入池
            const lyrics = this.cancelledFolderIds.has(scanFolderId)
                ? 0
                : this.syncLyricFiles(scanFolderId, diskFiles.lyrics, audioByBase);

            return {
                added: diff.added.length,
                updated: diff.changed.length,
                removed: diff.removed.length,
                unchanged: diff.unchanged,
                lyrics,
                elapsed: Date.now() - startTime,
            };
        } finally {
            this.isScanning = false;
            this.cancelledFolderIds.delete(scanFolderId);
        }
    }

    /**
     * 同步歌词文件池。
     *
     * 与音频一样做增量 diff，另外每次都对一遍「同名音频」：
     * 音频可能是这次扫描才出现的（歌词和歌曲分两批下载），
     * 只写新增歌词的话这些对不上，会一直显示成「孤儿歌词」。
     *
     * @returns 本次新增/更新的歌词文件数
     */
    private syncLyricFiles(
        scanFolderId: string,
        diskLyrics: IFileInfo[],
        audioByBase: Map<string, string>,
    ): number {
        const db = this.db.getDatabase();
        const dbRows = this.queries.getLocalLyricByScanFolder.all(scanFolderId) as Array<{
            file_path: string;
            file_size: number | null;
            file_mtime: number | null;
            audio_path: string | null;
        }>;
        const diff = diffWithDb(diskLyrics, dbRows);

        let changed = 0;
        db.transaction(() => {
            for (const file of [...diff.added, ...diff.changed]) {
                const fileName = path.basename(file.filePath).replace(/\.[^.]+$/, '');
                const { title, artist } = parseLyricFileName(fileName);
                this.queries.upsertLocalLyric.run({
                    filePath: file.filePath,
                    fileName,
                    title,
                    artist,
                    audioPath: audioByBase.get(baseKeyWithoutExt(file.filePath)) ?? null,
                    fileSize: file.size,
                    fileMtime: Math.floor(file.mtime),
                    scanFolderId,
                    createdAt: Date.now(),
                });
                changed++;
            }

            // 补配对：歌词没变、但它同名音频这次才扫进来
            for (const row of dbRows) {
                const paired = audioByBase.get(baseKeyWithoutExt(row.file_path)) ?? null;
                if (paired !== row.audio_path) {
                    this.queries.updateLocalLyricAudio.run({
                        filePath: row.file_path,
                        audioPath: paired,
                    });
                }
            }

            for (const fp of diff.removed) {
                this.queries.deleteLocalLyric.run(fp);
            }
        })();

        return changed;
    }

    // ─── local_music → IMusicItem 转换 ───

    private toMusicItems(rows: ILocalMusicItem[]): IMusic.IMusicItem[] {
        return rows.map((row) => this.toMusicItem(row));
    }

    /**
     * 将 local_music 行转为 IMusicItem。
     *
     * - 纯本地歌（platform = '本地'）→ url = file://path，不设 $slim
     * - App 下载的歌 → $slim: true 保护已有 raw，不写 url
     */
    private toMusicItem(row: ILocalMusicItem): IMusic.IMusicItem {
        if (row.platform === LOCAL_PLUGIN_NAME) {
            return {
                platform: row.platform,
                id: row.id,
                title: row.title,
                artist: row.artist,
                album: row.album,
                duration: row.duration ?? undefined,
                artwork: row.artwork ?? undefined,
                url: pathToFileURL(row.filePath).toString(),
                localPath: row.filePath,
                folder: row.folder,
            } as IMusic.IMusicItem;
        }
        return {
            platform: row.platform,
            id: row.id,
            title: row.title,
            artist: row.artist,
            album: row.album,
            duration: row.duration ?? undefined,
            artwork: row.artwork ?? undefined,
            [INTERNAL_SLIM_KEY]: true,
            folder: row.folder,
            localPath: row.filePath,
        } as IMusic.IMusicItem;
    }

    private broadcastProgress(progress: IScanProgress) {
        this.windowManager.broadcast(IPC.SCAN_PROGRESS, progress);
    }

    private broadcastLibraryChanged() {
        this.windowManager.broadcast(IPC.LIBRARY_CHANGED);
    }

    /**
     * 请求一次后台重扫（下载完成后调用）。
     *
     * 不重扫的话，新下载的文件要等下次启动的 60s 静默重扫才会出现在「本地音乐」——
     * 表现就是「文件明明在文件夹里、下载列表也有了，本地音乐列表却没有」。
     */
    public requestRescan(): void {
        void this.idleRescan();
    }

    /**
     * 空闲 rescan：启动后 60s 扫描所有文件夹。
     */
    private async idleRescan() {
        const folders = this.queries.getAllScanFolders.all() as IScanFolder[];
        if (folders.length === 0) return;

        let hasChanges = false;
        for (const folder of folders) {
            try {
                const result = await this.enqueueScan(folder.id, folder.folderPath);
                if (result.added > 0 || result.updated > 0 || result.removed > 0) {
                    this.queries.updateScanFolderLastScan.run({
                        id: folder.id,
                        lastScanAt: Date.now(),
                    });
                    hasChanges = true;
                }
            } catch {
                /* 静默扫描失败不影响正常使用 */
            }
        }
        if (hasChanges) {
            this.broadcastLibraryChanged();
        }
    }
}

const localMusic = new LocalMusicManager();
export default localMusic;
