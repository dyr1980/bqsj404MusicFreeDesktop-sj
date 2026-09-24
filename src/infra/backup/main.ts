/**
 * backup — 主进程层
 *
 * 职责:
 *  1. 编排导出/导入流程（文件 + WebDAV）
 *  2. 文件 I/O（读写备份 JSON）
 *  3. WebDAV 客户端（备份/恢复/测试连接）
 *  4. 进度上报（通过 webContents.send 推送到 renderer）
 *
 * 数据操作全部在主进程闭环完成，renderer 不经手原始歌单数据。
 */
import { ipcMain } from 'electron';
import fsp from 'fs/promises';
import { createClient, type WebDAVClient, AuthType } from 'webdav';
import type { IWindowManager } from '@appTypes/main/windowManager';
import type { IAppConfigReader } from '@appTypes/infra/appConfig';
import type {
    IBackupData,
    IBackupPreview,
    IBackupProvider,
    IBackupResult,
    IBackupSelection,
    RestoreMode,
    IBackupProgress,
} from '@appTypes/infra/backup';
import { IPC, WEBDAV_BACKUP_PATH ,
    SNAPSHOT_DIR,
    LATEST_BACKUP_PATH,
    SNAPSHOT_MAX_KEEP,
    SNAPSHOT_PREFIX,
    buildSnapshotName,
} from './common/constant';
import { selectSnapshotsToDelete, type ISnapshotFile } from './common/snapshotRetention';
// 与云盘模块共用同一套「Zotero-only DAV」兼容层（同为主进程模块，不会进渲染包）
import {
    davExtraHeaders,
    toLogicalName,
    toStoredPath,
} from '@infra/cloudDisk/main/zoteroDavCompat';

/** 由备份数据生成预览（选择性恢复的候选列表） */
function buildPreview(data: IBackupData): IBackupPreview {
    const sheets = (data.musicSheets ?? []).map((sheet) => ({
        id: sheet.id,
        title: sheet.title,
        count: (sheet.musicList ?? []).length,
    }));
    return {
        sheets,
        createdAt: data.createdAt,
        totalCount: sheets.reduce((sum, s) => sum + s.count, 0),
    };
}

class BackupManager {
    private isSetup = false;
    private windowManager!: IWindowManager;
    private appConfig!: IAppConfigReader;
    private backupProvider!: IBackupProvider;

    public setup(deps: {
        windowManager: IWindowManager;
        appConfig: IAppConfigReader;
        backupProvider: IBackupProvider;
    }) {
        if (this.isSetup) return;

        this.windowManager = deps.windowManager;
        this.appConfig = deps.appConfig;
        this.backupProvider = deps.backupProvider;

        this.registerIpcHandlers();

        this.isSetup = true;
    }

    // ─── 内部方法 ───

    private registerIpcHandlers(): void {
        // ─── 备份到文件 ───

        ipcMain.handle(
            IPC.BACKUP_TO_FILE,
            async (_evt, filePath: string): Promise<IBackupResult> => {
                try {
                    const data = this.buildBackupData();
                    await fsp.writeFile(filePath, JSON.stringify(data), 'utf-8');
                    const songsCount = data.musicSheets.reduce(
                        (sum, s) => sum + s.musicList.length,
                        0,
                    );
                    return {
                        success: true,
                        sheetsCount: data.musicSheets.length,
                        songsCount,
                    };
                } catch (e) {
                    return {
                        success: false,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            },
        );

        // ─── 从文件恢复 ───

        ipcMain.handle(
            IPC.RESTORE_FROM_FILE,
            async (
                _evt,
                filePath: string,
                mode: RestoreMode,
                selection?: IBackupSelection,
            ): Promise<IBackupResult> => {
                try {
                    const raw = await fsp.readFile(filePath, 'utf-8');
                    const data = parseBackupData(raw);

                    // 恢复前先给「当前状态」留一份快照（回滚保险）
                    await this.createPreRestoreSnapshot();

                    const importResult = this.backupProvider.importSheets(
                        data.musicSheets,
                        mode,
                        (current, total, sheetTitle) => {
                            this.sendProgress({ current, total, sheetTitle });
                        },
                        selection,
                    );

                    return {
                        success: true,
                        sheetsCount: importResult.sheetsCount,
                        songsCount: importResult.songsCount,
                    };
                } catch (e) {
                    return {
                        success: false,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            },
        );

        // ─── 预览备份文件（选择性恢复用） ───

        ipcMain.handle(
            IPC.PREVIEW_FILE,
            async (_evt, filePath: string): Promise<IBackupPreview> => {
                const raw = await fsp.readFile(filePath, 'utf-8');
                return buildPreview(parseBackupData(raw));
            },
        );

        ipcMain.handle(IPC.PREVIEW_WEBDAV, async (): Promise<IBackupPreview> => {
            const client = this.createWebDAVClient();
            const storedPath = toStoredPath(WEBDAV_BACKUP_PATH);
            const exists = await client.exists(storedPath);
            if (!exists) throw new Error('webdav_backup_file_not_exist');
            const raw = (await client.getFileContents(storedPath, {
                format: 'text',
            })) as string;
            return buildPreview(parseBackupData(raw));
        });

        // ─── 列出云端快照（多份留存情况） ───

        ipcMain.handle(IPC.GET_SNAPSHOTS, async (): Promise<ISnapshotFile[]> => {
            try {
                const client = this.createWebDAVClient();
                const files = await this.listSnapshots(client);
                return files.sort((a, b) => b.mtime - a.mtime);
            } catch {
                return [];
            }
        });

        // ─── 备份到 WebDAV ───

        ipcMain.handle(IPC.BACKUP_TO_WEBDAV, () => this.pushBackupToWebDAV());

        // ─── 从 WebDAV 恢复 ───

        ipcMain.handle(
            IPC.RESTORE_FROM_WEBDAV,
            async (
                _evt,
                mode: RestoreMode,
                selection?: IBackupSelection,
            ): Promise<IBackupResult> => {
                try {
                    const client = this.createWebDAVClient();

                    const storedBackupPath = toStoredPath(WEBDAV_BACKUP_PATH);
                    const exists = await client.exists(storedBackupPath);
                    if (!exists) {
                        return { success: false, error: 'webdav_backup_file_not_exist' };
                    }

                    const raw = (await client.getFileContents(storedBackupPath, {
                        format: 'text',
                    })) as string;
                    const data = parseBackupData(raw);

                    // 恢复前先给「当前状态」留一份快照（回滚保险）
                    await this.createPreRestoreSnapshot(client);

                    const importResult = this.backupProvider.importSheets(
                        data.musicSheets,
                        mode,
                        (current, total, sheetTitle) => {
                            this.sendProgress({ current, total, sheetTitle });
                        },
                        selection,
                    );

                    return {
                        success: true,
                        sheetsCount: importResult.sheetsCount,
                        songsCount: importResult.songsCount,
                    };
                } catch (e) {
                    return {
                        success: false,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            },
        );

        // ─── 测试 WebDAV 连通性 ───

        ipcMain.handle(IPC.TEST_WEBDAV, async (): Promise<IBackupResult> => {
            try {
                const client = this.createWebDAVClient();
                await client.getDirectoryContents('/');
                return { success: true };
            } catch (e) {
                return {
                    success: false,
                    error: e instanceof Error ? e.message : String(e),
                };
            }
        });
    }

    // ─── 快照 ───

    /**
     * 备份到 WebDAV：
     * 1) 写最新备份 latest.json（恢复默认读它）+ 老路径 MusicFreeBackup.json（兼容）
     * 2) 写一份时间戳快照（多份留存）
     * 3) 按保留策略清理旧快照（超出上限自动删除）
     */
    private async pushBackupToWebDAV(): Promise<IBackupResult> {
        try {
            const client = this.createWebDAVClient();
            const data = this.buildBackupData();
            const json = JSON.stringify(data);

            for (const dir of ['/MusicFree', SNAPSHOT_DIR]) {
                if (!(await client.exists(dir))) {
                    await client.createDirectory(dir);
                }
            }

            const contentLength = Buffer.byteLength(json, 'utf-8');

            // Zotero-only 的 DAV 只放行 .zip 结尾的上传 → 写的时候映射，读的时候用同一套映射还原
            await client.putFileContents(toStoredPath(LATEST_BACKUP_PATH), json, {
                overwrite: true,
                contentLength,
            });
            await client.putFileContents(toStoredPath(WEBDAV_BACKUP_PATH), json, {
                overwrite: true,
                contentLength,
            });

            const snapshotName = buildSnapshotName();
            await client.putFileContents(toStoredPath(`${SNAPSHOT_DIR}/${snapshotName}`), json, {
                overwrite: true,
                contentLength,
            });

            await this.pruneSnapshots(client);

            const songsCount = data.musicSheets.reduce((sum, s) => sum + s.musicList.length, 0);
            return {
                success: true,
                sheetsCount: data.musicSheets.length,
                songsCount,
            };
        } catch (e) {
            return {
                success: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    /** 列出云端快照（读不到返回空数组） */
    private async listSnapshots(client: WebDAVClient): Promise<ISnapshotFile[]> {
        try {
            const entries = await client.getDirectoryContents(SNAPSHOT_DIR);
            const list: Array<Record<string, any>> = Array.isArray(entries)
                ? (entries as Array<Record<string, any>>)
                : ((entries as { data?: Array<Record<string, any>> })?.data ?? []);
            return list
                .filter(
                    (e) =>
                        e?.type === 'file' &&
                        // 只统计时间戳快照：latest.json 不参与保留策略（永远不被清理）
                        // 注意用逻辑名判断：服务端存的是 `<名字>_<HMAC>.json.zip`
                        toLogicalName(String(e.basename ?? '')).startsWith(SNAPSHOT_PREFIX),
                )
                .map((e) => ({
                    // 对上层暴露逻辑名；真正删除时再映射回服务端存的名字
                    name: toLogicalName(String(e.basename)),
                    mtime: e.lastmod ? Date.parse(String(e.lastmod)) : Date.now(),
                }));
        } catch {
            return [];
        }
    }

    /** 按保留策略清理快照（总量上限 8，按 1 天/1 周/1 月/1 年递减密度） */
    private async pruneSnapshots(client: WebDAVClient): Promise<void> {
        const files = await this.listSnapshots(client);
        if (files.length <= SNAPSHOT_MAX_KEEP) return;

        const toDelete = selectSnapshotsToDelete(files, Date.now(), SNAPSHOT_MAX_KEEP);
        for (const name of toDelete) {
            try {
                await client.deleteFile(toStoredPath(`${SNAPSHOT_DIR}/${name}`));
            } catch (e) {
                console.warn(
                    `[Backup] 删除旧快照失败 ${name}:`,
                    e instanceof Error ? e.message : e,
                );
            }
        }
        console.log(
            `[Backup] 快照清理：共 ${files.length} 份 → 保留 ${files.length - toDelete.length} 份`,
        );
    }

    /**
     * 恢复前自动快照当前状态（回滚保险）。
     * best-effort：未配置 WebDAV 或上传失败都不影响恢复本身。
     */
    private async createPreRestoreSnapshot(client?: WebDAVClient): Promise<void> {
        try {
            const dav = client ?? this.createWebDAVClient();
            const json = JSON.stringify(this.buildBackupData());

            for (const dir of ['/MusicFree', SNAPSHOT_DIR]) {
                if (!(await dav.exists(dir))) {
                    await dav.createDirectory(dir);
                }
            }

            const name = buildSnapshotName(new Date(), '-pre-restore');
            await dav.putFileContents(`${SNAPSHOT_DIR}/${name}`, json, {
                overwrite: true,
                contentLength: Buffer.byteLength(json, 'utf-8'),
            });
            await this.pruneSnapshots(dav);
            console.log(`[Backup] 恢复前快照已保存: ${name}`);
        } catch (e) {
            console.warn('[Backup] 恢复前快照失败（已忽略）:', e instanceof Error ? e.message : e);
        }
    }

    /** 组装备份数据（主进程内直接调用 provider，不经 IPC） */ private buildBackupData(): IBackupData {
        const sheets = this.backupProvider.getExportableSheets();
        return {
            version: 1,
            createdAt: Date.now(),
            musicSheets: sheets.map((sheet) => ({
                id: sheet.id,
                title: sheet.title,
                musicList: this.backupProvider.getSheetMusicRaw(sheet.id),
            })),
        };
    }

    /** 从 appConfig 读取 WebDAV 配置并创建客户端 */
    private createWebDAVClient(): WebDAVClient {
        const url = this.appConfig.getConfigByKey('backup.webdav.url');
        const username = this.appConfig.getConfigByKey('backup.webdav.username');
        const password = this.appConfig.getConfigByKey('backup.webdav.password');

        if (!url || !username || !password) {
            throw new Error('webdav_data_not_complete');
        }

        return createClient(url, {
            authType: AuthType.Password,
            username,
            password,
            // Zotero-only 的 DAV（如中国科技云数据胶囊）会按 UA 判客户端类型
            headers: davExtraHeaders(url),
        });
    }

    /** 向主窗口发送进度事件 */
    private sendProgress(progress: IBackupProgress) {
        this.windowManager.sendTo('main', IPC.PROGRESS, progress);
    }
}

/** 解析备份数据（兼容旧版无 version 字段的格式） */
function parseBackupData(raw: string): IBackupData {
    const data = JSON.parse(raw);

    // 旧版格式：无 version 字段，直接有 musicSheets 数组
    if (!data.version && Array.isArray(data.musicSheets)) {
        return {
            version: 1,
            createdAt: Date.now(),
            musicSheets: data.musicSheets,
        };
    }

    if (data.version === 1) {
        return data as IBackupData;
    }

    throw new Error('unsupported_backup_format');
}

const backup = new BackupManager();
export default backup;
