import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard } from '../components/SettingsCard';
import { SettingRow } from '../components/SettingRow';
import { RadioGroup } from '@renderer/mainWindow/components/ui/RadioGroup';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Toggle } from '@renderer/mainWindow/components/ui/Toggle';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { useBufferedConfigInput } from '../hooks/useBufferedConfigInput';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { showModal, closeModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import backup from '@infra/backup/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import { uploadAllLocalFiles } from '@renderer/mainWindow/core/cloudUpload';
import cloudDisk from '@infra/cloudDisk/renderer';
import downloadManager from '@infra/downloadManager/renderer';
import localMusic from '@infra/localMusic/renderer';
import cloudAutoSync from '@renderer/mainWindow/core/cloudAutoSync';
import type { BackupRestoreChoice } from '@renderer/mainWindow/components/business/modals/BackupRestoreSelectModal';
import type { ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import type {
    RestoreMode,
    IBackupPreview,
    IBackupResult,
    IBackupSelection,
} from '@appTypes/infra/backup';

/**
 * 备份与恢复设置
 *
 * 配置项：backup.uploadLocalFiles、backup.autoBackup、backup.webdav.*
 */
export function BackupSection() {
    const { t } = useTranslation();
    const [uploadLocalFiles, setUploadLocalFiles] = useConfigValue('backup.uploadLocalFiles');
    const [uploadLyrics, setUploadLyrics] = useConfigValue('backup.uploadLyrics');
    const [autoBackup, setAutoBackup] = useConfigValue('backup.autoBackup');

    const webdavUrl = useBufferedConfigInput('backup.webdav.url');
    const webdavUsername = useBufferedConfigInput('backup.webdav.username');
    const webdavPassword = useBufferedConfigInput('backup.webdav.password');

    // 未配置 WebDAV 时默认本地文件备份；已配置则默认走云盘
    const [backupMode, setBackupMode] = useState<'file' | 'webdav'>(() => {
        const configured = !!(
            webdavUrl.localValue &&
            webdavUsername.localValue &&
            webdavPassword.localValue
        );
        return configured ? 'webdav' : 'file';
    });
    const [operating, setOperating] = useState(false);
    const [snapshotCount, setSnapshotCount] = useState<number | null>(null);

    /** 读取云端快照份数（失败保持 null，不打扰用户） */
    const refreshSnapshots = useCallback(async () => {
        try {
            const files = await backup.getSnapshots();
            setSnapshotCount(files.length);
        } catch {
            setSnapshotCount(null);
        }
    }, []);

    useEffect(() => {
        void refreshSnapshots();
    }, [refreshSnapshots]);

    /** 统一处理恢复结果 */
    const handleRestoreResult = useCallback(
        (result: IBackupResult) => {
            closeModal('BackupProgressModal');
            if (result.success) {
                // 带上数量，恢复完能立刻知道进了多少
                showToast(
                    t('settings.backup.resume_success_detail', {
                        sheets: result.sheetsCount ?? 0,
                        songs: result.songsCount ?? 0,
                    }),
                    { type: 'info' },
                );
            } else if (result.error) {
                showToast(
                    t('settings.backup.resume_fail', {
                        reason: t(`settings.backup.${result.error}`, result.error),
                    }),
                    { type: 'warn' },
                );
            }
        },
        [t],
    );

    /** 执行恢复。mode 由弹窗底部按钮决定（开始恢复=追加 / 覆盖恢复=同名覆盖）。 */
    const executeRestore = useCallback(
        async (
            mode: RestoreMode,
            selection: IBackupSelection | undefined,
            restoreFn: (mode: RestoreMode) => Promise<IBackupResult>,
        ) => {
            const doRestore = async () => {
                setOperating(true);
                showModal('BackupProgressModal', { action: 'restore' });
                try {
                    const result = await restoreFn(mode);
                    handleRestoreResult(result);
                } catch (e) {
                    closeModal('BackupProgressModal');
                    showToast(
                        t('settings.backup.resume_fail', {
                            reason: e instanceof Error ? e.message : String(e),
                        }),
                        { type: 'warn' },
                    );
                } finally {
                    setOperating(false);
                }
            };

            // 覆盖模式会清空现有歌单 → 二次确认
            if (mode === 'overwrite') {
                showModal('ConfirmModal', {
                    title: t('settings.backup.resume_music_sheet'),
                    message: t('settings.backup.overwrite_confirm'),
                    confirmDanger: true,
                    onConfirm: doRestore,
                });
            } else {
                await doRestore();
            }
        },
        [handleRestoreResult, t],
    );

    /**
     * 「按单曲下载到本地」：把选中的云端单曲取回本地下载目录，
     * 并写入下载记录（播放时本地优先命中）。**与歌单无关**。
     *
     * @param withLyrics 是否一并把 /MusicFree/lyrics 里的同名歌词恢复成本地 .lrc
     */
    const handleDownloadSingles = useCallback(
        async (singles: ICloudUploadRecord[], withLyrics: boolean) => {
            if (!singles.length) return;
            setOperating(true);
            showToast(t('settings.backup.download_start', { count: singles.length }), {
                type: 'info',
            });
            try {
                const result = await cloudDisk.downloadToLocal(
                    singles.map((s) => ({
                        remotePath: s.remotePath,
                        platform: s.platform,
                        musicId: s.musicId,
                        title: s.title,
                        artist: s.artist,
                    })),
                    { withLyrics },
                );
                // 刷新下载记录，让「本地优先」立刻生效
                await downloadManager.refreshDownloaded();
                // 下载目录若在「本地音乐」扫描范围内，重扫一次让新文件入库（增量 diff，开销很小）
                try {
                    const folders = await localMusic.getScanFolders();
                    if (folders.length) {
                        await localMusic.syncScanFolders(folders.map((f) => f.folderPath));
                    }
                } catch (e) {
                    console.warn('[Backup] 下载后重新扫描本地音乐失败:', e);
                }
                showToast(
                    t('settings.backup.download_done', {
                        downloaded: result.downloaded,
                        skipped: result.skipped,
                        failed: result.failed,
                    }),
                    { type: result.failed > 0 ? 'warn' : 'info' },
                );
                if (result.lyrics > 0) {
                    showToast(t('settings.backup.restore_lyrics_done', { count: result.lyrics }), {
                        type: 'info',
                    });
                }
                if (result.errors.length) {
                    console.warn('[Backup] 下载失败明细:', result.errors);
                }
            } catch (e) {
                showToast(
                    t('settings.backup.download_fail', {
                        reason: e instanceof Error ? e.message : String(e),
                    }),
                    { type: 'warn' },
                );
            } finally {
                setOperating(false);
            }
        },
        [t],
    );

    /**
     * 打开恢复弹窗：先预览备份内容，再在弹窗里选恢复方式与范围。
     */
    const openSelectiveRestore = useCallback(
        async (
            loadPreview: () => Promise<IBackupPreview>,
            withSelection: (
                mode: RestoreMode,
                selection?: IBackupSelection,
            ) => Promise<IBackupResult>,
        ) => {
            setOperating(true);
            try {
                const [preview, uploadedSingles] = await Promise.all([
                    loadPreview(),
                    cloudDisk.getAllUploads().catch((): ICloudUploadRecord[] => []),
                ]);
                showModal('BackupRestoreSelectModal', {
                    preview,
                    uploadedSingles,
                    onConfirm: (choice: BackupRestoreChoice) => {
                        if (choice.kind === 'singles') {
                            void handleDownloadSingles(choice.singles, choice.withLyrics);
                            return;
                        }
                        const selection: IBackupSelection = { sheetIds: choice.sheetIds };
                        void executeRestore(choice.mode, selection, (m) =>
                            withSelection(m, selection),
                        );
                    },
                });
            } catch (e) {
                showToast(
                    t('settings.backup.resume_fail', {
                        reason: e instanceof Error ? e.message : String(e),
                    }),
                    { type: 'warn' },
                );
            } finally {
                setOperating(false);
            }
        },
        [executeRestore, t, handleDownloadSingles],
    );

    // ─── 文件备份 ───

    /** 备份完成后按配置上传本地文件到云盘（best-effort，失败不影响备份结果） */
    const maybeUploadLocalFiles = useCallback(async () => {
        if (!uploadLocalFiles) return;
        try {
            await uploadAllLocalFiles();
        } catch (e) {
            console.warn('[Backup] 上传本地文件到云盘失败:', e);
        }
    }, [uploadLocalFiles]);

    const handleBackupToFile = useCallback(async () => {
        const dialogResult = await systemUtil.showSaveDialog({
            title: t('settings.backup.backup_music_sheet'),
            defaultPath: `MusicFreeBackup_${formatDate()}.json`,
            filters: [
                {
                    name: t('settings.backup.musicfree_backup_file'),
                    extensions: ['json'],
                },
            ],
        });
        if (dialogResult.canceled || !dialogResult.filePath) return;

        setOperating(true);
        try {
            const result = await backup.backupToFile(dialogResult.filePath);
            if (result.success) {
                showToast(t('settings.backup.backup_success'), { type: 'info' });
                await maybeUploadLocalFiles();
            } else if (result.error) {
                showToast(t('settings.backup.backup_fail', { reason: result.error }), {
                    type: 'warn',
                });
            }
        } catch (e) {
            showToast(
                t('settings.backup.backup_fail', {
                    reason: e instanceof Error ? e.message : String(e),
                }),
                { type: 'warn' },
            );
        } finally {
            setOperating(false);
        }
    }, [t, maybeUploadLocalFiles]);

    const handleRestoreFromFile = useCallback(async () => {
        const dialogResult = await systemUtil.showOpenDialog({
            title: t('settings.backup.resume_music_sheet'),
            filters: [
                {
                    name: t('settings.backup.musicfree_backup_file'),
                    extensions: ['json'],
                },
            ],
            properties: ['openFile'],
        });
        if (dialogResult.canceled || !dialogResult.filePaths[0]) return;

        const filePath = dialogResult.filePaths[0];
        // 恢复弹窗里选恢复方式与范围
        return openSelectiveRestore(
            () => backup.previewFile(filePath),
            (mode, selection) => backup.restoreFromFile(filePath, mode, selection),
        );
    }, [openSelectiveRestore, t]);

    // ─── WebDAV ───

    const handleTestWebdav = useCallback(async () => {
        setOperating(true);
        try {
            const result = await backup.testWebDAV();
            if (result.success) {
                showToast(t('settings.backup.webdav_connect_success'), { type: 'info' });
            } else {
                showToast(t('settings.backup.webdav_connect_fail'), {
                    type: 'warn',
                    description: result.error,
                });
            }
        } catch {
            showToast(t('settings.backup.webdav_connect_fail'), { type: 'warn' });
        } finally {
            setOperating(false);
        }
    }, [t]);

    const handleBackupToWebDAV = useCallback(async () => {
        setOperating(true);
        try {
            const result = await backup.backupToWebDAV();
            if (result.success) {
                showToast(t('settings.backup.backup_success'), { type: 'info' });
                void refreshSnapshots();
                await maybeUploadLocalFiles();
            } else if (result.error) {
                showToast(
                    t('settings.backup.backup_fail', {
                        reason: t(`settings.backup.${result.error}`, result.error),
                    }),
                    { type: 'warn' },
                );
            }
        } catch (e) {
            showToast(
                t('settings.backup.backup_fail', {
                    reason: e instanceof Error ? e.message : String(e),
                }),
                { type: 'warn' },
            );
        } finally {
            setOperating(false);
        }
    }, [t, maybeUploadLocalFiles]);

    const handleRestoreFromWebDAV = useCallback(() => {
        return openSelectiveRestore(
            () => backup.previewWebDAV(),
            (mode, selection) => backup.restoreFromWebDAV(mode, selection),
        );
    }, [openSelectiveRestore]);

    return (
        <SettingsCard
            title={t('settings.section_name.backup')}
            subtitle={t('settings.backup.card_subtitle')}
        >
            <SettingRow
                label={t('settings.backup.auto_backup_label')}
                description={t('settings.backup.auto_backup_desc')}
                control={
                    <Toggle
                        checked={autoBackup ?? false}
                        onChange={(val) => {
                            setAutoBackup(val);
                            // 打开时立即标记待同步，避免要等到下个周期
                            if (val) cloudAutoSync.markPending();
                        }}
                    />
                }
            />
            <SettingRow
                label={t('settings.backup.snapshot_label')}
                description={t('settings.backup.snapshot_desc')}
                control={
                    <span className="backup-section__snapshot-count">
                        {snapshotCount === null
                            ? t('settings.backup.snapshot_unknown')
                            : t('settings.backup.snapshot_count', { count: snapshotCount })}
                    </span>
                }
            />
            <SettingRow
                label={t('settings.backup.upload_local_files_label')}
                description={t('settings.backup.upload_local_files_desc')}
                control={
                    <Toggle checked={uploadLocalFiles ?? false} onChange={setUploadLocalFiles} />
                }
            />
            <SettingRow
                label={t('settings.backup.upload_lyrics_label')}
                description={t('settings.backup.upload_lyrics_desc')}
                control={<Toggle checked={uploadLyrics ?? true} onChange={setUploadLyrics} />}
            />
            <SettingRow
                label={t('settings.backup.backup_mode_label')}
                description={t('settings.backup.backup_mode_desc')}
                control={
                    <RadioGroup
                        value={backupMode}
                        onChange={(val) => setBackupMode(val as 'file' | 'webdav')}
                        options={[
                            {
                                value: 'file',
                                label: t('settings.backup.backup_by_file'),
                            },
                            {
                                value: 'webdav',
                                label: t('settings.backup.backup_by_webdav'),
                            },
                        ]}
                    />
                }
            />

            {backupMode === 'file' ? (
                <div className="p-setting__action-row">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleBackupToFile}
                        disabled={operating}
                    >
                        {t('settings.backup.backup_to_file')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRestoreFromFile}
                        disabled={operating}
                    >
                        {t('settings.backup.restore_from_file')}
                    </Button>
                </div>
            ) : (
                <>
                    <SettingRow
                        label={t('settings.backup.webdav_server_url')}
                        description="https://dav.example.com"
                        control={
                            <Input
                                value={webdavUrl.localValue}
                                onChange={webdavUrl.handleChange}
                                onBlur={webdavUrl.handleBlur}
                                placeholder="https://dav.example.com"
                            />
                        }
                    />
                    <SettingRow
                        label={t('settings.backup.username')}
                        control={
                            <Input
                                value={webdavUsername.localValue}
                                onChange={webdavUsername.handleChange}
                                onBlur={webdavUsername.handleBlur}
                                placeholder={t('settings.backup.username')}
                            />
                        }
                    />
                    <SettingRow
                        label={t('settings.backup.password')}
                        control={
                            <Input
                                value={webdavPassword.localValue}
                                onChange={webdavPassword.handleChange}
                                onBlur={webdavPassword.handleBlur}
                                placeholder={t('settings.backup.password')}
                                type="password"
                            />
                        }
                    />
                    <div className="p-setting__action-row">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleTestWebdav}
                            disabled={operating}
                        >
                            {t('settings.backup.test_connection')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleBackupToWebDAV}
                            disabled={operating}
                        >
                            {t('settings.backup.backup_to_cloud')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleRestoreFromWebDAV}
                            disabled={operating}
                        >
                            {t('settings.backup.restore_from_cloud')}
                        </Button>
                    </div>
                </>
            )}
        </SettingsCard>
    );
}

/** 格式化日期为 YYYYMMDD_HHmmss（用于默认备份文件名） */
function formatDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
