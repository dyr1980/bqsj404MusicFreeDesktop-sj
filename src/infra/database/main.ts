/**
 * database — 主进程层
 *
 * 职责：
 * - 初始化数据库连接（Electron 内置 `node:sqlite`，WAL 模式）
 * - 基于 user_version pragma 的增量 schema 迁移
 * - 通过 IDatabaseProvider 接口向其他 main 层模块提供 DB 连接
 *
 * 为什么用 `node:sqlite` 而不是 better-sqlite3：
 *   better-sqlite3 是**按 Electron ABI 编译**的原生模块（`bindings` + `prebuild-install`），
 *   每次升级 Electron 都要重新编译，且新 ABI 初期没有预编译包 → 需要 VS Build Tools + node-gyp。
 *   Electron 内置的 Node 自带 SQLite（`node:sqlite`），**零编译**、随 Electron 自动升级。
 *   实测：项目 49 条真实 SQL 语句两引擎结果零差异（见 check-sqlite-migration.cjs）。
 *
 * 此模块仅 main 层，无 preload / renderer。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import type { IDatabaseProvider, IDbCompat } from '@appTypes/infra/database';
import { buildMediaNameKey } from '@common/mediaNameKey';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import { PLAY_QUEUE_SHEET_ID, DOWNLOADED_SHEET_ID } from '@infra/musicSheet/common/constant';
import { createTransactionFactory } from './transaction';
import { DB_FILE_NAME } from './common/constant';

class DatabaseInfra implements IDatabaseProvider {
    private isSetup = false;
    private db: IDbCompat | null = null;

    /**
     * 初始化数据库连接并执行 schema 迁移。
     * 应在 appConfig 之后、musicSheet / downloadManager 之前调用。
     */
    public setup() {
        if (this.isSetup) return;

        const dbPath = path.join(globalContext.appPath.userData, DB_FILE_NAME);
        this.db = this.withCompat(new DatabaseSync(dbPath));

        // ⚠️ 这两句必须显式设置，且必须早于任何写操作：
        //   node:sqlite 新连接的 synchronous 默认值与 better-sqlite3 不同，
        //   不设 NORMAL 时每次提交都会 fsync —— 实测 1000 次小事务 1064.8ms vs 48.1ms（慢 20 倍以上）。
        // WAL 模式：并发读不阻塞写，写不阻塞读
        this.db.exec('PRAGMA journal_mode = WAL');
        // 在 WAL 模式下 NORMAL 足够安全，写入速度远快于 FULL
        this.db.exec('PRAGMA synchronous = NORMAL');

        this.runMigrations();
        this.isSetup = true;
    }

    public getDatabase(): IDbCompat {
        if (!this.db) {
            throw new Error('[database] Module not initialized. Call setup() first.');
        }
        return this.db;
    }

    /** 关闭数据库连接。应在应用退出时最后调用。 */
    public dispose() {
        this.db?.close();
        this.db = null;
    }

    /**
     * 给 `DatabaseSync` 补上 better-sqlite3 的两个方法，避免改动 24 处调用点。
     *
     * - `transaction()`：实现见 `./transaction.ts`（SAVEPOINT 嵌套 + 预编译语句）
     * - `pragma()`：`node:sqlite` 没有 pragma 辅助器，这里用 exec/prepare 包一层
     *   （写入式 `name = value` 走 exec，读取式返回一行；`{ simple: true }` 取第一列）
     */
    private withCompat(db: DatabaseSync): IDbCompat {
        // 兼容方法直接挂在同一个连接对象上（不再包一层），
        // 这样 getDatabase() 的返回值既是 node:sqlite 连接、又带 better-sqlite3 的两个方法。
        const compat = db as unknown as IDbCompat;

        compat.transaction = createTransactionFactory(db) as IDbCompat['transaction'];

        compat.pragma = (pragma: string, opts?: { simple?: boolean }): unknown => {
            const trimmed = pragma.trim();
            if (trimmed.includes('=')) {
                // 写入式 pragma（如 user_version = 12）：不返回结果行
                db.exec(`PRAGMA ${trimmed}`);
                return undefined;
            }
            const row = db.prepare(`PRAGMA ${trimmed}`).get() as
                | Record<string, unknown>
                | undefined;
            if (!row) return undefined;
            return opts?.simple ? Object.values(row)[0] : row;
        };

        return compat;
    }

    /**
     * Schema 版本迁移。
     *
     * 使用 SQLite 内置的 user_version pragma 跟踪版本号。
     * 每个 migration 函数对应一个版本升级（v0→v1, v1→v2, ...）。
     * 所有 migration 在一个事务中执行，保证原子性。
     */
    private runMigrations() {
        const db = this.db!;
        const currentVersion = db.pragma('user_version', { simple: true }) as number;

        const migrations: Array<(db: IDbCompat) => void> = [
            // ─── v0 → v1: 初始 schema ───
            (db) => {
                // musicSheet 模块的表
                db.exec(`
                    CREATE TABLE IF NOT EXISTS music_sheets (
                        id          TEXT PRIMARY KEY,
                        title       TEXT NOT NULL,
                        artwork     TEXT,
                        description TEXT,
                        type        TEXT NOT NULL DEFAULT 'user',
                        folder_path TEXT,
                        sort_order  INTEGER DEFAULT 0,
                        created_at  INTEGER NOT NULL,
                        updated_at  INTEGER NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS music_items (
                        platform    TEXT NOT NULL,
                        id          TEXT NOT NULL,
                        title       TEXT NOT NULL,
                        artist      TEXT DEFAULT '',
                        album       TEXT DEFAULT '',
                        duration    REAL,
                        artwork     TEXT,
                        raw         TEXT,
                        PRIMARY KEY (platform, id)
                    );

                    CREATE TABLE IF NOT EXISTS sheet_music_relation (
                        sheet_id    TEXT NOT NULL,
                        platform    TEXT NOT NULL,
                        music_id    TEXT NOT NULL,
                        sort_order  INTEGER DEFAULT 0,
                        added_at    INTEGER NOT NULL,
                        PRIMARY KEY (sheet_id, platform, music_id),
                        FOREIGN KEY (sheet_id) REFERENCES music_sheets(id) ON DELETE CASCADE,
                        FOREIGN KEY (platform, music_id) REFERENCES music_items(platform, id)
                    );

                    CREATE INDEX IF NOT EXISTS idx_relation_sheet_added
                        ON sheet_music_relation(sheet_id, added_at DESC);

                    CREATE TABLE IF NOT EXISTS starred_sheets (
                        platform    TEXT NOT NULL,
                        id          TEXT NOT NULL,
                        title       TEXT,
                        artwork     TEXT,
                        raw         TEXT,
                        sort_order  INTEGER DEFAULT 0,
                        starred_at  INTEGER NOT NULL,
                        PRIMARY KEY (platform, id)
                    );
                `);
            },

            // ─── v1 → v2: (已废弃) pre_shuffle_order 列，shuffle 已改为纯内存虚拟导航 ───
            // 保留迁移槽位以兼容已升级到 v2 的用户数据库
            () => {},

            // ─── v2 → v3: mediaMeta 模块的 media_meta 表 ───
            (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS media_meta (
                        platform    TEXT NOT NULL,
                        music_id    TEXT NOT NULL,
                        data        TEXT NOT NULL DEFAULT '{}',
                        updated_at  INTEGER NOT NULL,
                        PRIMARY KEY (platform, music_id)
                    );
                `);
            },

            // ─── v3 → v4: downloadManager 的 download_tasks 表 + mediaMeta shadow 列 ───
            (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS download_tasks (
                        id                TEXT PRIMARY KEY,
                        platform          TEXT NOT NULL,
                        music_id          TEXT NOT NULL,
                        title             TEXT NOT NULL,
                        artist            TEXT DEFAULT '',
                        album             TEXT DEFAULT '',
                        quality           TEXT NOT NULL,
                        status            TEXT NOT NULL DEFAULT 'pending',
                        file_path         TEXT,
                        temp_path         TEXT,
                        total_bytes       INTEGER DEFAULT 0,
                        downloaded_bytes  INTEGER DEFAULT 0,
                        media_source      TEXT,
                        music_item_raw    TEXT,
                        error             TEXT,
                        created_at        INTEGER NOT NULL,
                        updated_at        INTEGER NOT NULL
                    );

                    CREATE UNIQUE INDEX IF NOT EXISTS idx_download_tasks_unique_music
                        ON download_tasks(platform, music_id);

                    CREATE INDEX IF NOT EXISTS idx_download_tasks_status
                        ON download_tasks(status);

                    ALTER TABLE media_meta ADD COLUMN download_path TEXT;

                    CREATE INDEX IF NOT EXISTS idx_media_meta_download_path
                        ON media_meta(download_path COLLATE NOCASE);
                `);
            },

            // ─── v4 → v5: localMusic 模块的 scan_folders + local_music 表 ───
            (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS scan_folders (
                        id              TEXT PRIMARY KEY,
                        folder_path     TEXT NOT NULL UNIQUE,
                        last_scan_at    INTEGER,
                        created_at      INTEGER NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS local_music (
                        file_path       TEXT PRIMARY KEY,
                        platform        TEXT NOT NULL,
                        music_id        TEXT NOT NULL,
                        title           TEXT NOT NULL,
                        artist          TEXT DEFAULT '',
                        album           TEXT DEFAULT '',
                        duration        REAL,
                        artwork         TEXT,
                        folder          TEXT NOT NULL,
                        file_size       INTEGER,
                        file_mtime      INTEGER,
                        scan_folder_id  TEXT NOT NULL,
                        created_at      INTEGER NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_local_music_artist
                        ON local_music(artist);
                    CREATE INDEX IF NOT EXISTS idx_local_music_album
                        ON local_music(album);
                    CREATE INDEX IF NOT EXISTS idx_local_music_folder
                        ON local_music(folder);
                    CREATE INDEX IF NOT EXISTS idx_local_music_scan_folder
                        ON local_music(scan_folder_id);
                    CREATE INDEX IF NOT EXISTS idx_local_music_identity
                        ON local_music(platform, music_id);
                `);
            },

            // ─── v5 → v6: 云盘上传清单（区分手动/自动上传，供选择性恢复） ───
            (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS cloud_uploads (
                        id              INTEGER PRIMARY KEY AUTOINCREMENT,
                        platform        TEXT NOT NULL,
                        music_id        TEXT NOT NULL,
                        title           TEXT DEFAULT '',
                        artist          TEXT DEFAULT '',
                        remote_path     TEXT NOT NULL,
                        local_path      TEXT,
                        source          TEXT NOT NULL,
                        size            INTEGER,
                        uploaded_at     INTEGER NOT NULL,
                        UNIQUE(platform, music_id, remote_path)
                    );

                    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_source
                        ON cloud_uploads(source);
                    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_identity
                        ON cloud_uploads(platform, music_id);
                    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_remote
                        ON cloud_uploads(remote_path);
                `);
            },

            // ─── v6 → v7: 本地歌词文件扫描（.lrc 池，供歌词搜索手动关联） ───
            (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS local_lyric (
                        file_path       TEXT PRIMARY KEY,
                        file_name       TEXT NOT NULL,
                        title           TEXT DEFAULT '',
                        artist          TEXT DEFAULT '',
                        audio_path      TEXT,
                        file_size       INTEGER,
                        file_mtime      INTEGER,
                        scan_folder_id  TEXT NOT NULL,
                        created_at      INTEGER NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_local_lyric_name
                        ON local_lyric(file_name);
                    CREATE INDEX IF NOT EXISTS idx_local_lyric_scan_folder
                        ON local_lyric(scan_folder_id);
                    CREATE INDEX IF NOT EXISTS idx_local_lyric_audio
                        ON local_lyric(audio_path);
                `);
            },

            // ─── v7 → v8: 「换到本地/云盘」的原始身份落到 music_items ───
            // 队列/歌单里的条目 platform 会被改写成 本地/云盘，原始 platform+id 必须跟着持久化，
            // 否则重启后下载记录、手动关联的歌词、还原来源全都对不上号。
            (db) => {
                db.exec(`
                    ALTER TABLE music_items ADD COLUMN origin_platform TEXT;
                    ALTER TABLE music_items ADD COLUMN origin_id TEXT;
                    ALTER TABLE music_items ADD COLUMN source_matched INTEGER;
                `);
            },

            // ─── v8 → v9: 作品键（work_key）───────────────────────────
            //
            // 背景：`platform + id` 是「从哪儿取播放」的出处键，但同一首作品在不同插件下
            // 的 platform+id 不同（`周杰伦 - 烟花易冷` 在酷我/QQ歌词/元力KW 各有各的 id）。
            // 把「作品级」的状态（歌词偏移、手动关联歌词、下载记录、云盘已上传）挂在这个键上，
            // 换个插件播同一首歌就全都对不上号 —— 之前只能靠 originPlatform + 「歌名+歌手」
            // 三级兜底去救，救不全还容易认错。
            //
            // 这里给三张状态表加一列 work_key = 归一化(歌名|歌手)，作为「作品」这一层的键；
            // 旧的 platform/music_id 列**全部保留**（取源、歌单成员、条目缓存仍然只能用它），
            // 读的时候先按 work_key 找、找不到再按 (platform, music_id) 回退（双读期）。
            //
            // 回填用 JS 算（归一化是正则，SQL 做不了）：能查到条目的按条目的歌名/歌手算，
            // 算不出来的留 NULL，靠双读兜底。列不参与主键，随时可以停用/回滚。
            (db) => {
                db.exec(`
                    ALTER TABLE media_meta ADD COLUMN work_key TEXT;
                    ALTER TABLE cloud_uploads ADD COLUMN work_key TEXT;
                    ALTER TABLE local_music ADD COLUMN work_key TEXT;

                    CREATE INDEX IF NOT EXISTS idx_media_meta_work_key ON media_meta(work_key);
                    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_work_key ON cloud_uploads(work_key);
                    CREATE INDEX IF NOT EXISTS idx_local_music_work_key ON local_music(work_key);
                `);
                backfillWorkKeys(db);
            },

            // ─── v9 → v10: 清掉「没有歌名」的假作品键 ───
            // v9 第一版把「歌名/歌手都缺失」的条目算成了 `|`，一堆互不相干的歌
            // 因此共享同一个作品键（会互相串歌词偏移 / 下载记录）。这里清成 NULL，
            // 读取时按旧键 (platform, music_id) 回退。
            (db) => {
                const BOGUS = `work_key IS NOT NULL AND (instr(work_key, '|') = 0
                    OR substr(work_key, 1, instr(work_key, '|') - 1) = '')`;
                db.exec(`
                    UPDATE media_meta SET work_key = NULL WHERE ${BOGUS};
                    UPDATE cloud_uploads SET work_key = NULL WHERE ${BOGUS};
                    UPDATE local_music SET work_key = NULL WHERE ${BOGUS};
                `);
            },

            // ─── v10 → v11: 文件真值与下载记录脱钩 ────────────────────
            //
            // 背景：「本地有没有这个文件」以前是拿下载记录（media_meta.download_path）
            // 回答的，而「已下载」图标走的是文件系统真值 —— 删掉下载记录（保留文件）后
            // 图标亮着、取源却掉到云端/插件；扫描时还会用 download_path 反查来决定
            // 文件的 platform/id，记录一没，同一个文件在库里就换了身份。
            //
            // 定稿口径：
            //   - 文件真值（local_music 表）是「本地有没有文件」的唯一权威；
            //   - work_key（归一化 歌名|歌手）是「这首歌是谁」的权威；
            //   - 下载记录只表达「任务/状态」（音质、下载时间），不再回答文件存在性。
            //
            // 为此：
            //   1. music_items 也带上 work_key（身份解析不再依赖下载记录反查）；
            //   2. local_music 补 quality / source（记录来源，供取源音质匹配与展示）；
            //   3. 历史身份重挂：把当年因为「记录在」而被挂成插件的文件，
            //      在记录消失后重新按 work_key 挂回已知条目。
            (db) => {
                db.exec(`
                    ALTER TABLE music_items ADD COLUMN work_key TEXT;
                    CREATE INDEX IF NOT EXISTS idx_music_items_work_key ON music_items(work_key);

                    ALTER TABLE local_music ADD COLUMN quality TEXT;
                    ALTER TABLE local_music ADD COLUMN source TEXT;
                `);
                backfillMusicItemWorkKeys(db);
                backfillLocalMusicRecordColumns(db);
                reattachLocalMusicIdentity(db);
            },

            // ─── v11 → v12: 修正 v11 挑得不够准的本地库身份 ───
            // 同一作品有多个插件身份又都没下载记录时，v11 只按「后写入」挑，
            // 可能挑到用户没在用的那个（例如歌词插件）。这里对有其他候选在播放队列里、
            // 而当前身份不在队列中的行，换成队列里那一份。
            (db) => {
                refineLocalMusicIdentity(db);
            },
        ];

        if (currentVersion < migrations.length) {
            const migrate = db.transaction(() => {
                for (let i = currentVersion; i < migrations.length; i++) {
                    migrations[i](db);
                }
                db.pragma(`user_version = ${migrations.length}`);
            });
            migrate();
        }
    }
}

/**
 * v9 回填：给三张状态表算 work_key。
 *
 * - `media_meta` / `cloud_uploads` / `local_music` 的 (platform, music_id) 先去
 *   `music_items` 找条目的歌名/歌手；找不到就用表里已有的 title/artist 列。
 * - 算不出来（歌名或歌手都为空）就留 NULL，读取时按旧键回退。
 */
function backfillWorkKeys(db: IDbCompat): void {
    const lookupItem = db.prepare(
        'SELECT title, artist FROM music_items WHERE platform = ? AND id = ?',
    );
    const updateMediaMeta = db.prepare(
        'UPDATE media_meta SET work_key = ? WHERE platform = ? AND music_id = ?',
    );
    const updateCloud = db.prepare(
        "UPDATE cloud_uploads SET work_key = ? WHERE platform = ? AND music_id = ? AND COALESCE(work_key, '') = ''",
    );
    const updateLocal = db.prepare(
        "UPDATE local_music SET work_key = ? WHERE file_path = ? AND COALESCE(work_key, '') = ''",
    );

    const mediaRows = db
        .prepare(
            "SELECT platform, music_id AS musicId FROM media_meta WHERE COALESCE(work_key, '') = ''",
        )
        .all() as Array<{ platform: string; musicId: string }>;
    for (const row of mediaRows) {
        const item = lookupItem.get(row.platform, String(row.musicId)) as
            | { title?: string; artist?: string }
            | undefined;
        const key = buildMediaNameKey(item?.title ?? '', item?.artist ?? '');
        if (key) updateMediaMeta.run(key, row.platform, String(row.musicId));
    }

    const cloudRows = db
        .prepare('SELECT platform, music_id AS musicId, title, artist FROM cloud_uploads')
        .all() as Array<{ platform: string; musicId: string; title: string; artist: string }>;
    for (const row of cloudRows) {
        const key = buildMediaNameKey(row.title, row.artist);
        if (key) updateCloud.run(key, row.platform, String(row.musicId));
    }

    const localRows = db
        .prepare('SELECT file_path AS filePath, title, artist FROM local_music')
        .all() as Array<{ filePath: string; title: string; artist: string }>;
    for (const row of localRows) {
        const key = buildMediaNameKey(row.title, row.artist);
        if (key) updateLocal.run(key, row.filePath);
    }
}

/**
 * v11 回填：给 `music_items` 算 work_key。
 *
 * 身份解析（扫描入库、换源匹配）从此按作品键走，不再需要「下载记录反查」。
 * `music_items` 的 title/artist 就是完整信息，直接用它们算。
 */
function backfillMusicItemWorkKeys(db: IDbCompat): void {
    const rows = db
        .prepare(
            "SELECT platform, id, title, artist FROM music_items WHERE COALESCE(work_key, '') = ''",
        )
        .all() as Array<{ platform: string; id: string; title?: string; artist?: string }>;
    const update = db.prepare('UPDATE music_items SET work_key = ? WHERE platform = ? AND id = ?');
    for (const row of rows) {
        const key = buildMediaNameKey(row.title ?? '', row.artist ?? '');
        if (key) update.run(key, row.platform, String(row.id));
    }
}

/**
 * v11 回填：`local_music.quality` / `source`。
 *
 * 能从下载记录（`media_meta.download_path`）对上这个文件路径的，说明当初是 App 下载的：
 * 音质取记录里的，来源标 `download`；其余（用户自己扫进来的）标 `scan` 且音质未知。
 *
 * 注意这只是**回填展示/音质匹配用的元信息**，不再参与「本地有没有文件」的判断。
 */
function backfillLocalMusicRecordColumns(db: IDbCompat): void {
    db.exec(`
        UPDATE local_music
           SET quality = (
                   SELECT NULLIF(json_extract(mm.data, '$.downloadData.quality'), '')
                     FROM media_meta mm
                    WHERE mm.download_path = local_music.file_path COLLATE NOCASE
                    LIMIT 1
               ),
               source = CASE
                   WHEN EXISTS (
                       SELECT 1 FROM media_meta mm2
                        WHERE mm2.download_path = local_music.file_path COLLATE NOCASE
                   ) THEN 'download'
                   ELSE 'scan'
               END;
    `);
}

/**
 * v11 历史身份重挂。
 *
 * 以前扫描入库时，文件的 platform/id 是用 `media_meta.download_path` 反查出来的：
 * 记录在 → 挂成原插件；记录被移除（文件保留）→ 变成 `本地` + md5(路径)。
 * 结果同一份文件在「本地音乐」里和歌单/队列里的身份对不上，取源只能再靠下载记录兜。
 *
 * 改为按 work_key 挂：同一作品在 `music_items` 里有多个插件身份时，挑**最可信**的那个
 * （有下载记录 > 出现在播放队列 > 出现在用户歌单 > 后写入），本地文件挂到它上面。
 */
function reattachLocalMusicIdentity(db: IDbCompat): void {
    const best = pickBestIdentitiesByWorkKey(db);

    const localRows = db
        .prepare(
            `SELECT file_path AS filePath, platform, music_id AS musicId, work_key AS workKey
               FROM local_music WHERE COALESCE(work_key, '') <> ''`,
        )
        .all() as Array<{ filePath: string; platform: string; musicId: string; workKey: string }>;

    const hasItem = db.prepare('SELECT 1 AS ok FROM music_items WHERE platform = ? AND id = ?');
    const updateIdentity = db.prepare(
        'UPDATE local_music SET platform = @platform, music_id = @id WHERE file_path = @filePath',
    );
    const metaExists = db.prepare(
        'SELECT 1 AS ok FROM media_meta WHERE platform = ? AND music_id = ?',
    );
    const moveMeta = db.prepare(
        'UPDATE media_meta SET platform = @platform, music_id = @id WHERE platform = @oldPlatform AND music_id = @oldId',
    );

    for (const row of localRows) {
        const target = best.get(row.workKey);
        if (!target) continue;
        const sameTarget =
            target.platform === row.platform && String(target.id) === String(row.musicId);
        if (sameTarget) continue;

        // 只在「当前身份是本地兜底」或「当前身份已经查不到条目」时重挂，避免无谓改写
        const currentIsLocal = row.platform === LOCAL_PLUGIN_NAME;
        const currentAlive = !!hasItem.get(row.platform, String(row.musicId));
        if (!currentIsLocal && currentAlive) continue;

        updateIdentity.run({
            filePath: row.filePath,
            platform: target.platform,
            id: String(target.id),
        });

        // 本地兜底身份上的歌词偏移 / 自定义封面别丢：目标身份没有记录时搬过去
        if (currentIsLocal) {
            if (!metaExists.get(target.platform, String(target.id))) {
                moveMeta.run({
                    platform: target.platform,
                    id: String(target.id),
                    oldPlatform: row.platform,
                    oldId: String(row.musicId),
                });
            }
        }
    }
}

/**
 * 每个作品键挑一个最可信的条目身份。
 *
 * 排序（越靠前越可信）：
 *   1. 有下载记录的条目 —— 这份文件当初就是它下载的
 *   2. 出现在播放队列里的条目 —— 用户实际播过它
 *   3. 出现在用户歌单里的条目 —— 用户收藏过它
 *   4. 后写入的条目
 */
function pickBestIdentitiesByWorkKey(db: IDbCompat): Map<string, { platform: string; id: string }> {
    const candidates = db
        .prepare(
            `SELECT mi.platform AS platform, mi.id AS id, mi.work_key AS workKey,
                    mi.rowid AS rowid,
                    (SELECT COUNT(*) FROM media_meta mm
                      WHERE mm.platform = mi.platform AND mm.music_id = mi.id
                        AND mm.download_path IS NOT NULL) AS hasDownload,
                    (SELECT COUNT(*) FROM sheet_music_relation q
                      WHERE q.platform = mi.platform AND q.music_id = mi.id
                        AND q.sheet_id = ?) AS inQueue,
                    (SELECT COUNT(*) FROM sheet_music_relation s
                      WHERE s.platform = mi.platform AND s.music_id = mi.id
                        AND s.sheet_id NOT IN (?, ?)) AS inUserSheet
               FROM music_items mi
              WHERE COALESCE(mi.work_key, '') <> ''`,
        )
        .all(PLAY_QUEUE_SHEET_ID, PLAY_QUEUE_SHEET_ID, DOWNLOADED_SHEET_ID) as Array<{
        platform: string;
        id: string;
        workKey: string;
        rowid: number;
        hasDownload: number;
        inQueue: number;
        inUserSheet: number;
    }>;

    candidates.sort(
        (a, b) =>
            b.hasDownload - a.hasDownload ||
            b.inQueue - a.inQueue ||
            b.inUserSheet - a.inUserSheet ||
            b.rowid - a.rowid,
    );

    const best = new Map<string, { platform: string; id: string }>();
    for (const row of candidates) {
        if (row.platform === LOCAL_PLUGIN_NAME) continue;
        if (!best.has(row.workKey)) {
            best.set(row.workKey, { platform: row.platform, id: String(row.id) });
        }
    }
    return best;
}

/**
 * v11 → v12：用更精确的排序修正 v11 落下的身份。
 *
 * v11 第一版只按「有下载记录 → 后写入」挑身份：同一作品有多个插件身份、
 * 又都没有下载记录时（例如「蒲公英的约定」同时有元力KW / 酷我 / 弥音QQ / QQ歌词
 * 四个身份），可能挑到一个用户根本没在用的（歌词插件）身份。
 * 这里对**没有下载记录支撑**的本地库行重新评估一次：
 * 当前身份不在播放队列、而有别的候选在播放队列里 → 换成那个。
 */
function refineLocalMusicIdentity(db: IDbCompat): void {
    const best = pickBestIdentitiesByWorkKey(db);
    const inQueue = db.prepare(
        'SELECT COUNT(*) AS c FROM sheet_music_relation WHERE platform = ? AND music_id = ? AND sheet_id = ?',
    );
    const rows = db
        .prepare(
            `SELECT lm.file_path AS filePath, lm.platform AS platform, lm.music_id AS musicId,
                    lm.work_key AS workKey,
                    (SELECT COUNT(*) FROM media_meta mm
                      WHERE mm.platform = lm.platform AND mm.music_id = lm.music_id
                        AND mm.download_path IS NOT NULL) AS hasDownload
               FROM local_music lm WHERE COALESCE(lm.work_key, '') <> ''`,
        )
        .all() as Array<{
        filePath: string;
        platform: string;
        musicId: string;
        workKey: string;
        hasDownload: number;
    }>;
    const updateIdentity = db.prepare(
        'UPDATE local_music SET platform = @platform, music_id = @id WHERE file_path = @filePath',
    );

    for (const row of rows) {
        // 有下载记录支撑的身份不动（那份文件就是它下载的）
        if (row.hasDownload > 0) continue;
        const target = best.get(row.workKey);
        if (!target) continue;
        if (target.platform === row.platform && target.id === row.musicId) continue;

        const currentInQueue = (
            inQueue.get(row.platform, row.musicId, PLAY_QUEUE_SHEET_ID) as { c: number }
        ).c;
        const targetInQueue = (
            inQueue.get(target.platform, target.id, PLAY_QUEUE_SHEET_ID) as { c: number }
        ).c;
        if (currentInQueue > 0 || targetInQueue === 0) continue;

        updateIdentity.run({
            filePath: row.filePath,
            platform: target.platform,
            id: target.id,
        });
    }
}

const database = new DatabaseInfra();
export default database;
