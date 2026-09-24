/**
 * cloudAutoSync — 云盘自动备份/同步（渲染层编排）
 *
 * 开启「自动备份」后：
 *  1. 本地发生变更（下载完成 / 本地音乐库变化 / 我喜欢·收藏变化）→ 标记「有待同步」
 *  2. 延迟合并：由定时器（默认 15 分钟）检查，有待同步才真正执行
 *  3. 同步内容（幂等、可重跑，所以天然支持「关机后开机补跑」）：
 *     ① 推送歌单备份 JSON（含快照与保留策略）
 *     ② 增量上传本地文件（同名同大小自动跳过）—— 仅在「同时上传本地音乐文件」开启时执行
 *     ③ 对账删除：清单里有、但本地文件已不存在的 → 远端移入 /MusicFree/trash/ —— 同上，跟随该开关
 *  4. 若启动时发现上次没同步完（pendingAt > 0）→ 立即补跑一次
 *
 * 状态保存在 appConfig：
 *  - backup.autoBackup      开关
 *  - backup.syncPendingAt   待同步标记（0 = 无）
 *  - backup.lastSyncAt      上次同步完成时间
 */

import appConfig from '@infra/appConfig/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import backup from '@infra/backup/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import localMusic from '@infra/localMusic/renderer';
import musicSheet from '@infra/musicSheet/renderer';
import { collectAllLocalTasks } from './cloudUpload';
import { uploadKey } from '@infra/cloudDisk/common/syncPlan';
import { buildMediaNameKey } from '@common/mediaNameKey';

/** 对账检查间隔（也是变更后的最大延迟） */
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** 启动后延迟补跑时间（等各模块就绪） */
const STARTUP_CATCHUP_DELAY_MS = 30 * 1000;

class CloudAutoSync {
    private isSetup = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;

    /** 初始化：订阅变更 + 启动定时对账 + 开机补跑 */
    public setup(): void {
        if (this.isSetup) return;
        this.isSetup = true;

        // ── 变更事件 → 标记待同步 ──
        try {
            downloadManager.subscribeDownloadChange(() => this.markPending());
        } catch {
            // 忽略：订阅失败不影响其它触发
        }
        localMusic.onLibraryChanged(() => this.markPending());
        try {
            musicSheet.subscribeFavoriteChange(() => this.markPending());
            musicSheet.subscribeStarredChange(() => this.markPending());
        } catch {
            // 忽略
        }

        // ── 定时对账 ──
        this.timer = setInterval(() => {
            void this.maybeSync('interval');
        }, SYNC_INTERVAL_MS);

        // ── 开机补跑 ──
        setTimeout(() => {
            void this.onStartup();
        }, STARTUP_CATCHUP_DELAY_MS);
    }

    /** 标记「有待同步」（合并连续变更，写配置做持久化） */
    public markPending(): void {
        if (!appConfig.getConfigByKey('backup.autoBackup')) return;
        if (this.pendingWriteTimer) return; // 300ms 内只写一次
        this.pendingWriteTimer = setTimeout(() => {
            this.pendingWriteTimer = null;
            appConfig.setConfig({ 'backup.syncPendingAt': Date.now() });
        }, 300);
    }

    /** 启动逻辑：开着自动备份且上次没同步完 → 立即补跑 */
    private async onStartup(): Promise<void> {
        if (!appConfig.getConfigByKey('backup.autoBackup')) return;
        const pendingAt = appConfig.getConfigByKey('backup.syncPendingAt') ?? 0;
        const lastSyncAt = appConfig.getConfigByKey('backup.lastSyncAt') ?? 0;
        const neverSynced = !lastSyncAt;
        // 有待同步，或距上次同步已超过一个周期 → 补跑
        if (pendingAt > 0 || neverSynced) {
            console.log(
                `[CloudAutoSync] 启动补跑（pending=${pendingAt > 0 ? 'yes' : 'no'}, lastSync=${lastSyncAt || 'never'}）`,
            );
            await this.runSync();
        }
    }

    /** 定时器 / 手动触发：仅在有待同步标记时执行 */
    private async maybeSync(reason: string): Promise<void> {
        if (!appConfig.getConfigByKey('backup.autoBackup')) return;
        const pendingAt = appConfig.getConfigByKey('backup.syncPendingAt') ?? 0;
        if (!pendingAt) return;
        console.log(`[CloudAutoSync] 开始同步（触发：${reason}）`);
        await this.runSync();
    }

    /** 执行一次完整对账同步（幂等，可重复调用） */
    public async runSync(): Promise<void> {
        if (this.running) return;
        this.running = true;

        try {
            // ① 推送歌单备份 JSON（写 latest + 时间戳快照 + 保留策略清理）
            const backupResult = await backup.backupToWebDAV();
            if (!backupResult.success) {
                throw new Error(backupResult.error ?? 'backup_failed');
            }

            // ②③ 只有开了「同时上传本地音乐文件」才动云端的音频文件。
            //
            // 之前这里是无条件上传的：用户只开了「自动备份」（以为只备份歌单），
            // 本地音乐就会被悄悄传上云 —— 和设置项的字面意思完全不符。
            if (!appConfig.getConfigByKey('backup.uploadLocalFiles')) {
                console.log(
                    '[CloudAutoSync] 未开启「同时上传本地音乐文件」→ 本次只同步歌单，不动云端音频',
                );
                appConfig.setConfig({
                    'backup.syncPendingAt': 0,
                    'backup.lastSyncAt': Date.now(),
                });
                return;
            }

            // ② 增量上传本地文件
            const tasks = await collectAllLocalTasks();
            const uploadResult = tasks.length ? await cloudDisk.uploadTasks(tasks, 'auto') : null;

            // ③ 对账删除：本地已彻底删除的歌 → 远端移入回收站
            //    保守判定在主进程做（仍在本地的歌即使换了路径/换了插件也会保留）
            const managedKeys = tasks.map((t) =>
                uploadKey(t.platform ?? '', t.id != null ? String(t.id) : ''),
            );
            // 作品键也要给：同一首歌换个插件播/换来源后 (platform,id) 会变，
            // 只按它对账会把好好的云备份误判成「本地已删除」
            const managedWorkKeys = tasks
                .map((t) => buildMediaNameKey(t.title, t.artist))
                .filter(Boolean);
            const movedCount = await cloudDisk.trashMissingLocalFiles(managedKeys, managedWorkKeys);

            console.log(
                `[CloudAutoSync] 同步完成：上传 ${uploadResult?.uploaded ?? 0} / 跳过 ${uploadResult?.skipped ?? 0} / 失败 ${uploadResult?.failed ?? 0}，移入回收站 ${movedCount}`,
            );
            if (uploadResult?.errors?.length) {
                console.warn('[CloudAutoSync] 上传失败明细:', uploadResult.errors);
            }

            appConfig.setConfig({
                'backup.syncPendingAt': 0,
                'backup.lastSyncAt': Date.now(),
            });
        } catch (e) {
            // 失败保留 pending 标记 → 下个周期或下次启动自动重试
            console.warn(
                '[CloudAutoSync] 同步失败（将自动重试）:',
                e instanceof Error ? e.message : e,
            );
        } finally {
            this.running = false;
        }
    }

    /** 关闭（应用退出时） */
    public dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

const cloudAutoSync = new CloudAutoSync();
export default cloudAutoSync;
