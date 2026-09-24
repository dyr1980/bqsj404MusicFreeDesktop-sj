/**
 * mediaMeta — 主进程层
 *
 * 职责：
 * - 管理 media_meta 表的 CRUD（prepared statements）
 * - RFC 7396 JSON Merge Patch 更新语义
 * - IPC 注册（handle + broadcast）
 * - 启动时异步执行过期清理
 *
 * 暴露名称: '@infra/media-meta'
 */

import { ipcMain } from 'electron';
import type { IDbCompat, IDbStatement, IDatabaseProvider } from '@appTypes/infra/database';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type {
    IMediaMeta,
    IMediaIdentity,
    MediaMetaPatch,
    IMediaMetaChangeEvent,
    IMediaMetaProvider,
} from '@appTypes/infra/mediaMeta';
import { compositeKey } from '@common/mediaKey';
import { buildMediaNameKey } from '@common/mediaNameKey';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import { IPC } from './common/constant';

interface IQueries {
    getMeta: IDbStatement;
    getMetaRow: IDbStatement;
    getMetaByWorkKey: IDbStatement;
    getMusicIdentity: IDbStatement;
    upsertMeta: IDbStatement;
    deleteMeta: IDbStatement;
    queryByField: IDbStatement;
    cleanExpired: IDbStatement;
    getMetaByDownloadPath: IDbStatement;
    getAllDownloaded: IDbStatement;
}

/** 过期清理阈值（毫秒）：90 天 */
const EXPIRY_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

class MediaMetaManager {
    private isSetup = false;
    private db!: IDbCompat;
    private windowManager!: IWindowManager;
    private queries!: IQueries;

    public setup(deps: { db: IDatabaseProvider; windowManager: IWindowManager }) {
        if (this.isSetup) return;

        this.db = deps.db.getDatabase();
        this.windowManager = deps.windowManager;

        this.queries = {
            getMeta: this.db.prepare(
                'SELECT data FROM media_meta WHERE platform = ? AND music_id = ?',
            ),
            getMetaRow: this.db.prepare(
                'SELECT platform, music_id AS musicId, data, work_key AS workKey FROM media_meta WHERE platform = ? AND music_id = ?',
            ),
            getMetaByWorkKey: this.db.prepare(
                `SELECT platform, music_id AS musicId, data, work_key AS workKey, updated_at AS updatedAt
                 FROM media_meta WHERE work_key = ?
                 ORDER BY updated_at DESC`,
            ),
            getMusicIdentity: this.db.prepare(
                'SELECT title, artist FROM music_items WHERE platform = ? AND id = ?',
            ),
            upsertMeta: this.db.prepare(`
                INSERT INTO media_meta (platform, music_id, data, updated_at, download_path, work_key)
                VALUES (@platform, @musicId, @data, @updatedAt, @downloadPath, @workKey)
                ON CONFLICT(platform, music_id) DO UPDATE SET
                    data = @data, updated_at = @updatedAt, download_path = @downloadPath,
                    work_key = COALESCE(excluded.work_key, media_meta.work_key)
            `),
            deleteMeta: this.db.prepare(
                'DELETE FROM media_meta WHERE platform = ? AND music_id = ?',
            ),
            queryByField: this.db.prepare(
                `SELECT platform, music_id, data FROM media_meta
                 WHERE json_extract(data, '$.' || ?) IS NOT NULL`,
            ),
            cleanExpired: this.db.prepare(`
                DELETE FROM media_meta
                WHERE updated_at < ?
                  AND NOT EXISTS (
                      SELECT 1 FROM sheet_music_relation smr
                      WHERE smr.platform = media_meta.platform
                        AND smr.music_id = media_meta.music_id
                  )
            `),
            getMetaByDownloadPath: this.db.prepare(
                'SELECT platform, music_id, data FROM media_meta WHERE download_path = ? COLLATE NOCASE',
            ),
            getAllDownloaded: this.db.prepare(
                `SELECT mm.platform, mm.music_id, mm.data, mm.work_key AS workKey,
                        mm.updated_at AS updatedAt,
                        mi.title AS title, mi.artist AS artist
                 FROM media_meta mm
                 LEFT JOIN music_items mi
                        ON mi.platform = mm.platform AND mi.id = mm.music_id
                 WHERE mm.download_path IS NOT NULL`,
            ),
        };

        this.registerIpcHandlers();

        // 启动时异步执行过期清理
        this.scheduleCleanup();

        this.isSetup = true;
    }

    // ─── 核心方法（供 Main 进程内其他模块通过 DI 调用） ────────

    /** 获取单条 meta */
    public getMeta(platform: string, musicId: string): IMediaMeta | null {
        const row = this.queries.getMeta.get(platform, musicId) as { data: string } | undefined;
        return row ? JSON.parse(row.data) : null;
    }

    /**
     * 按作品键取 meta：同一首作品可能有多条记录（各插件键下各一条），
     * 需要合并成「用户视角的那一份」。
     *
     * 合并规则（字段级）：
     * - `downloadData`：精确键那条优先，否则取最近一条有下载记录的
     * - `associatedLyric`：`source === 'manual'` 优先（用户手动关联永远优先），
     *   否则精确键那条，再否则最近一条
     * - `lyricOffset` / `artwork`：精确键那条的字段存在就用它（哪怕是 0 / 空），
     *   否则取最近一条带该字段的
     *
     * @returns merged meta + 它实际来自哪条记录（写回/清理用）
     */
    public getMetaForItem(
        platform: string,
        musicId: string,
        identity?: IMediaIdentity,
    ): { meta: IMediaMeta; platform: string; musicId: string } | null {
        const exactRow = this.queries.getMetaRow.get(platform, musicId) as
            | { platform: string; musicId: string; data: string; workKey: string | null }
            | undefined;
        // 老数据里可能有「没有歌名」的假键（`|`）→ 当作没有键，别把互不相干的歌并到一起
        const rawWorkKey = exactRow?.workKey ?? this.resolveWorkKey(platform, musicId, identity);
        const workKey = rawWorkKey && rawWorkKey.split('|')[0] ? rawWorkKey : null;

        type Row = { platform: string; musicId: string; meta: IMediaMeta; isExact: boolean };
        const rows: Row[] = [];
        if (exactRow) {
            rows.push({
                platform: exactRow.platform,
                musicId: exactRow.musicId,
                meta: JSON.parse(exactRow.data),
                isExact: true,
            });
        }
        if (workKey) {
            const siblings = this.queries.getMetaByWorkKey.all(workKey) as Array<{
                platform: string;
                musicId: string;
                data: string;
            }>;
            for (const s of siblings) {
                if (s.platform === platform && String(s.musicId) === String(musicId)) continue;
                rows.push({
                    platform: s.platform,
                    musicId: String(s.musicId),
                    meta: JSON.parse(s.data),
                    isExact: false,
                });
            }
        }
        if (!rows.length) return null;

        const exact = rows.find((r) => r.isExact) ?? null;
        const merged: IMediaMeta = {};

        // downloadData：精确键优先
        const withDownload =
            (exact?.meta.downloadData ? exact : null) ??
            rows.find((r) => r.meta.downloadData) ??
            null;
        if (withDownload?.meta.downloadData) merged.downloadData = withDownload.meta.downloadData;

        // associatedLyric：手动关联优先
        const manual = rows.find((r) => r.meta.associatedLyric?.source === 'manual');
        const withLyricAssoc =
            manual ??
            (exact?.meta.associatedLyric ? exact : null) ??
            rows.find((r) => r.meta.associatedLyric);
        if (withLyricAssoc?.meta.associatedLyric)
            merged.associatedLyric = withLyricAssoc.meta.associatedLyric;

        // 其余逐字段：精确键那条有就用它，否则最近一条
        for (const key of ['lyricOffset', 'artwork'] as const) {
            const fromExact = exact && exact.meta[key] !== undefined ? exact : null;
            const picked = fromExact ?? rows.find((r) => r.meta[key] !== undefined);
            if (picked) merged[key] = picked.meta[key] as never;
        }

        const source = exact ?? rows[0];
        return { meta: merged, platform: source.platform, musicId: source.musicId };
    }

    /**
     * 批量获取 meta。
     * 返回 [compositeKey, IMediaMeta] 元组数组，方便序列化传输。
     */
    public batchGetMeta(
        keys: Array<{ platform: string; musicId: string }>,
    ): Array<[string, IMediaMeta]> {
        const result: Array<[string, IMediaMeta]> = [];
        for (const { platform, musicId } of keys) {
            const meta = this.getMeta(platform, musicId);
            if (meta) {
                result.push([compositeKey(platform, musicId), meta]);
            }
        }
        return result;
    }

    /**
     * 设置 meta（RFC 7396 JSON Merge Patch）。
     *
     * 读取现有 data → 遍历 patch：null 值删除 key，非 null 值覆盖 → 写回。
     * 各模块可独立更新自己负责的字段，互不干扰。
     */
    public setMeta(
        platform: string,
        musicId: string,
        patch: MediaMetaPatch,
        identity?: IMediaIdentity,
    ): void {
        const existing = this.getMeta(platform, musicId) ?? ({} as IMediaMeta);
        const merged: Record<string, unknown> = { ...existing };

        for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
                delete merged[key];
            } else {
                merged[key] = value;
            }
        }

        // Shadow 列自动同步：从 downloadData.path 提取到 download_path
        const mergedMeta = merged as IMediaMeta;
        const downloadPath = mergedMeta.downloadData?.path ?? null;

        this.queries.upsertMeta.run({
            platform,
            musicId,
            data: JSON.stringify(merged),
            updatedAt: Date.now(),
            downloadPath,
            workKey: this.resolveWorkKey(platform, musicId, identity),
        });

        this.broadcast({ platform, musicId, meta: mergedMeta });
    }

    /** 删除 meta */
    public deleteMeta(platform: string, musicId: string): void {
        this.queries.deleteMeta.run(platform, musicId);
        this.broadcast({ platform, musicId, meta: null });
    }

    /**
     * 通过下载路径反查原始歌曲的 platform + musicId。
     * 供本地扫描引擎在主进程内通过 DI 调用，不暴露 IPC。
     */
    public getMetaByDownloadPath(
        filePath: string,
    ): { platform: string; musicId: string; meta: IMediaMeta } | null {
        const row = this.queries.getMetaByDownloadPath.get(filePath) as
            | { platform: string; music_id: string; data: string }
            | undefined;
        if (!row) return null;
        return {
            platform: row.platform,
            musicId: row.music_id,
            meta: JSON.parse(row.data),
        };
    }

    /**
     * 获取所有已下载歌曲的下载信息。
     * 使用 download_path shadow 列索引扫描，避免 json_extract 全表扫描。
     *
     * 顺带带上歌名/歌手（join music_items）：渲染层要靠它做「同一首歌换了插件」的
     * 本地兜底匹配——同一首歌在不同插件下 id 不同，只按 platform+id 会漏掉本地文件。
     */
    public getAllDownloaded(): Array<{
        platform: string;
        musicId: string;
        path: string;
        quality: IMusic.IQualityKey;
        title?: string;
        artist?: string;
        workKey?: string;
        downloadedAt?: number;
    }> {
        const rows = this.queries.getAllDownloaded.all() as Array<{
            platform: string;
            music_id: string;
            data: string;
            workKey: string | null;
            updatedAt: number | null;
            title: string | null;
            artist: string | null;
        }>;
        const result: Array<{
            platform: string;
            musicId: string;
            path: string;
            quality: IMusic.IQualityKey;
            title?: string;
            artist?: string;
            workKey?: string;
            downloadedAt?: number;
        }> = [];
        for (const row of rows) {
            const meta: IMediaMeta = JSON.parse(row.data);
            if (meta.downloadData) {
                result.push({
                    platform: row.platform,
                    musicId: row.music_id,
                    path: meta.downloadData.path,
                    quality: meta.downloadData.quality,
                    title: row.title ?? undefined,
                    artist: row.artist ?? undefined,
                    // 老记录 work_key 可能是 NULL → 用歌名/歌手现算，别让渲染层少这一级匹配
                    workKey: row.workKey || buildMediaNameKey(row.title, row.artist) || undefined,
                    // 下载时间：新记录写在 downloadData.at；老记录退回 meta 的 updated_at
                    downloadedAt: meta.downloadData.at ?? row.updatedAt ?? undefined,
                });
            }
        }
        return result;
    }

    /**
     * 返回统一的 DI 适配器，供 downloadManager / localMusic / pluginManager 等消费。
     */
    public getProvider(): IMediaMetaProvider {
        return {
            setMeta: this.setMeta.bind(this),
            getDownloadData: (platform: string, musicId: string) => {
                // 作品级读取：换插件播同一首歌也能拿到下载记录
                const merged =
                    this.getMetaForItem(platform, musicId)?.meta ?? this.getMeta(platform, musicId);
                return merged?.downloadData ?? null;
            },
            getAllDownloaded: () => this.getAllDownloaded(),
            getMetaByDownloadPath: (filePath: string) => {
                const result = this.getMetaByDownloadPath(filePath);
                return result ? { platform: result.platform, musicId: result.musicId } : null;
            },
            findIdentityByWorkKey: (workKey: string) => this.findIdentityByWorkKey(workKey),
            getAssociatedLyric: (platform: string, musicId: string) => {
                const merged =
                    this.getMetaForItem(platform, musicId)?.meta ?? this.getMeta(platform, musicId);
                return merged?.associatedLyric ?? null;
            },
        };
    }

    /**
     * 按作品键找一条已知条目身份（跨插件）。
     *
     * 本地库文件解析身份时用：这个作品在库里出现过（有 media_meta 行）就复用它，
     * 从而**不依赖下载记录**也能让本地文件挂上和歌单/队列一致的身份。
     * 优先非「本地」身份——「本地」身份对不上歌单里的条目。
     */
    public findIdentityByWorkKey(workKey: string): { platform: string; musicId: string } | null {
        if (!workKey) return null;
        const rows = this.queries.getMetaByWorkKey.all(workKey) as Array<{
            platform: string;
            musicId: string;
        }>;
        if (!rows.length) return null;
        const preferred = rows.find((r) => r.platform !== LOCAL_PLUGIN_NAME) ?? rows[0];
        return { platform: preferred.platform, musicId: String(preferred.musicId) };
    }

    /** 按字段查询所有含该字段的 meta（如 'downloadData'） */
    public queryByField(
        field: string,
    ): Array<{ platform: string; musicId: string; meta: IMediaMeta }> {
        const rows = this.queries.queryByField.all(field) as Array<{
            platform: string;
            music_id: string;
            data: string;
        }>;
        return rows.map((r) => ({
            platform: r.platform,
            musicId: r.music_id,
            meta: JSON.parse(r.data),
        }));
    }

    // ─── 内部方法 ────────────────────────

    /**
     * 算「作品键」：归一化(歌名|歌手)，与插件无关。
     *
     * 优先用调用方给的歌名/歌手；没给就去 `music_items` 查这条 (platform, id)。
     */
    private resolveWorkKey(
        platform: string,
        musicId: string,
        identity?: IMediaIdentity,
    ): string | null {
        let title = identity?.title ?? null;
        let artist = identity?.artist ?? null;
        if (title == null && artist == null) {
            const item = this.queries.getMusicIdentity.get(platform, musicId) as
                | { title: string | null; artist: string | null }
                | undefined;
            title = item?.title ?? null;
            artist = item?.artist ?? null;
        }
        return buildMediaNameKey(title, artist) || null;
    }

    private registerIpcHandlers(): void {
        ipcMain.handle(
            IPC.GET_META,
            (_evt, platform: string, musicId: string, identity?: IMediaIdentity) => {
                // 带歌名/歌手时按作品键合并读取（跨插件）
                if (identity && (identity.title || identity.artist)) {
                    return this.getMetaForItem(platform, musicId, identity)?.meta ?? null;
                }
                return this.getMeta(platform, musicId);
            },
        );

        ipcMain.handle(
            IPC.BATCH_GET_META,
            (_evt, keys: Array<{ platform: string; musicId: string }>) => {
                return this.batchGetMeta(keys);
            },
        );

        ipcMain.handle(
            IPC.SET_META,
            (
                _evt,
                platform: string,
                musicId: string,
                patch: MediaMetaPatch,
                identity?: IMediaIdentity,
            ) => {
                this.setMeta(platform, musicId, patch, identity);
            },
        );

        ipcMain.handle(IPC.DELETE_META, (_evt, platform: string, musicId: string) => {
            this.deleteMeta(platform, musicId);
        });

        ipcMain.handle(IPC.QUERY_BY_FIELD, (_evt, field: string) => {
            return this.queryByField(field);
        });
    }

    /** 广播 meta 变更事件到所有渲染进程窗口 */
    private broadcast(event: IMediaMetaChangeEvent): void {
        this.windowManager.broadcast(IPC.META_CHANGED, event);
    }

    /**
     * 异步执行过期清理。
     * 双条件：updated_at 超过阈值 AND 不在任何 sheet_music_relation 中。
     */
    private scheduleCleanup(): void {
        setTimeout(() => {
            try {
                const threshold = Date.now() - EXPIRY_THRESHOLD_MS;
                this.queries.cleanExpired.run(threshold);
            } catch (e) {
                console.error('[mediaMeta] cleanup failed:', e);
            }
        }, 10000); // 延迟 10s，避免阻塞启动
    }
}

const mediaMeta = new MediaMetaManager();
export default mediaMeta;
