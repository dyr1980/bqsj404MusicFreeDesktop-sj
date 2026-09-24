import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare, MinusSquare, Search, Square } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { RadioGroup } from '@renderer/mainWindow/components/ui/RadioGroup';
import { CheckboxGroup } from '@renderer/mainWindow/components/ui/CheckboxGroup';
import { Toggle } from '@renderer/mainWindow/components/ui/Toggle';
import { compositeKey } from '@common/mediaKey';
import { cloudDisplayName } from '@infra/cloudDisk/common/syncPlan';
import type { IBackupPreview, RestoreMode } from '@appTypes/infra/backup';
import type { ICloudUploadRecord } from '@appTypes/infra/cloudDisk';
import './index.scss';

/** 单次最多渲染的选项数（超出用搜索缩小范围，避免上千首时卡顿） */
const RENDER_LIMIT = 200;

export interface BackupRestoreSelectModalProps {
    close: () => void;
    /** 备份内容预览 */
    preview: IBackupPreview;
    /** 云盘上传过的单曲清单（手动 + 自动都算） */
    uploadedSingles: ICloudUploadRecord[];
    /** 确认：按歌单恢复（追加/覆盖由点的按钮决定）or 把单曲下载到本地 */
    onConfirm: (choice: BackupRestoreChoice) => void;
}

/** 弹窗的两种动作 */
export type BackupRestoreChoice =
    | { kind: 'sheets'; mode: RestoreMode; sheetIds: string[] }
    | { kind: 'singles'; singles: ICloudUploadRecord[]; withLyrics: boolean };

/**
 * BackupRestoreSelectModal — 从云端取回内容（简化版）
 *
 *   - **按歌单恢复**：底部两个按钮
 *     - 开始恢复 = 追加（默认，现有歌单不受影响）
 *     - 覆盖恢复 = 同名覆盖（悬浮有说明；只替换同名的现有歌单）
 *   - **按单曲下载到本地**：把选中的单曲从云端下载到本地下载目录，
 *     播放时「本地优先」自动用本地文件 —— 与歌单无关
 *
 * 搜索 + 全选按钮同一行，全选图标与列表状态联动。
 */
export default function BackupRestoreSelectModal({
    close,
    preview,
    uploadedSingles,
    onConfirm,
}: BackupRestoreSelectModalProps) {
    const { t } = useTranslation();

    const [pickMode, setPickMode] = useState<'sheets' | 'singles'>('sheets');
    const [keyword, setKeyword] = useState('');
    const deferredKeyword = useDeferredValue(keyword);
    const [selectedSheets, setSelectedSheets] = useState<string[]>(preview.sheets.map((s) => s.id));
    const [selectedSingles, setSelectedSingles] = useState<string[]>(
        uploadedSingles.map((u) => compositeKey(u.platform, u.musicId)),
    );
    /** 按单曲恢复时，是否一并把云盘歌词恢复成本地 .lrc */
    const [withLyrics, setWithLyrics] = useState(true);

    const isSheets = pickMode === 'sheets';

    const sheetOptions = useMemo(
        () =>
            preview.sheets.map((sheet) => ({
                value: sheet.id,
                label: `${sheet.title} (${sheet.count})`,
            })),
        [preview.sheets],
    );

    const singleOptions = useMemo(
        () =>
            uploadedSingles.map((upload) => ({
                value: compositeKey(upload.platform, upload.musicId),
                // 一律显示云端文件名（去扩展名）：不依赖本地记录，也绝不显示歌曲 ID
                label: cloudDisplayName(upload.remotePath) || upload.musicId,
            })),
        [uploadedSingles],
    );

    // ── 关键字筛选（只影响显示，不影响已勾选状态） ──
    const allOptions = isSheets ? sheetOptions : singleOptions;
    const matchedOptions = useMemo(() => {
        const lower = deferredKeyword.trim().toLowerCase();
        return lower ? allOptions.filter((o) => o.label.toLowerCase().includes(lower)) : allOptions;
    }, [allOptions, deferredKeyword]);
    const visibleOptions = matchedOptions.slice(0, RENDER_LIMIT);
    const truncated = matchedOptions.length > RENDER_LIMIT;

    const selectedValues = isSheets ? selectedSheets : selectedSingles;
    const setSelectedValues = isSheets ? setSelectedSheets : setSelectedSingles;

    // ── 全选按钮状态与列表联动 ──
    const selectableValues = visibleOptions.map((o) => o.value);
    const selectedVisibleCount = selectableValues.filter((v) => selectedValues.includes(v)).length;
    const allChecked =
        selectableValues.length > 0 && selectedVisibleCount === selectableValues.length;
    const someChecked = selectedVisibleCount > 0 && !allChecked;

    const handleToggleAll = () => {
        if (allChecked) {
            const removing = new Set(selectableValues);
            setSelectedValues(selectedValues.filter((v) => !removing.has(v)));
        } else {
            setSelectedValues([...new Set([...selectedValues, ...selectableValues])]);
        }
    };

    const canConfirm = selectedValues.length > 0;

    const handleConfirm = (mode: RestoreMode) => {
        if (isSheets) {
            onConfirm({ kind: 'sheets', mode, sheetIds: selectedSheets });
        } else {
            onConfirm({
                kind: 'singles',
                withLyrics,
                singles: uploadedSingles.filter((u) =>
                    selectedSingles.includes(compositeKey(u.platform, u.musicId)),
                ),
            });
        }
        close();
    };

    const SelectAllIcon = allChecked ? CheckSquare : someChecked ? MinusSquare : Square;

    return (
        <Modal
            open
            onClose={close}
            title={t('settings.backup.select_restore_title')}
            size="md"
            footer={
                <>
                    <Button variant="secondary" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    {isSheets ? (
                        <>
                            {/* 覆盖恢复：悬浮说明「同名覆盖」 */}
                            <Button
                                variant="secondary"
                                disabled={!canConfirm}
                                title={t('settings.backup.overwrite_btn_tip')}
                                onClick={() => handleConfirm('overwrite')}
                            >
                                {t('settings.backup.overwrite_restore_btn')}
                            </Button>
                            <Button
                                variant="primary"
                                disabled={!canConfirm}
                                title={t('settings.backup.append_btn_tip')}
                                onClick={() => handleConfirm('append')}
                            >
                                {t('settings.backup.start_restore', {
                                    count: selectedValues.length,
                                })}
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="primary"
                            disabled={!canConfirm}
                            onClick={() => handleConfirm('append')}
                        >
                            {t('settings.backup.start_download', {
                                count: selectedValues.length,
                            })}
                        </Button>
                    )}
                </>
            }
        >
            <div className="backup-restore-select">
                <div className="backup-restore-select__summary">
                    {t('settings.backup.preview_summary', {
                        sheets: preview.sheets.length,
                        songs: preview.totalCount,
                    })}
                </div>

                <RadioGroup
                    value={pickMode}
                    onChange={(val) => {
                        setPickMode(val as 'sheets' | 'singles');
                        setKeyword('');
                    }}
                    options={[
                        { value: 'sheets', label: t('settings.backup.select_by_sheet') },
                        { value: 'singles', label: t('settings.backup.select_by_single') },
                    ]}
                />

                {/* 追加 / 覆盖：由下方按钮决定；单曲模式固定下载到本地 */}
                {!isSheets && (
                    <>
                        <div className="backup-restore-select__hint">
                            {t('settings.backup.restore_singles_hint')}
                        </div>
                        {/* 顺带把 /MusicFree/lyrics 里的同名歌词恢复成本地 .lrc */}
                        <div className="backup-restore-select__option">
                            <Toggle checked={withLyrics} onChange={setWithLyrics} />
                            <div className="backup-restore-select__option-text">
                                <div>{t('settings.backup.restore_lyrics_label')}</div>
                                <div className="backup-restore-select__option-desc">
                                    {t('settings.backup.restore_lyrics_desc')}
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {/* 搜索 + 全选（同一行） */}
                <div className="backup-restore-select__toolbar">
                    <Input
                        className="backup-restore-select__search"
                        prefix={<Search size={14} />}
                        placeholder={
                            isSheets
                                ? t('settings.backup.search_sheet')
                                : t('settings.backup.search_single')
                        }
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        allowClear
                        onClear={() => setKeyword('')}
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<SelectAllIcon size={15} />}
                        onClick={handleToggleAll}
                        disabled={selectableValues.length === 0}
                    >
                        {allChecked ? t('common.deselect_all') : t('common.select_all')}
                    </Button>
                </div>

                {!isSheets && singleOptions.length === 0 ? (
                    <div className="backup-restore-select__empty">
                        {t('settings.backup.no_manual_uploads')}
                    </div>
                ) : visibleOptions.length === 0 ? (
                    <div className="backup-restore-select__empty">{t('common.no_result')}</div>
                ) : (
                    <>
                        {truncated && (
                            <div className="backup-restore-select__hint">
                                {t('settings.backup.list_truncated', { count: RENDER_LIMIT })}
                            </div>
                        )}
                        <div className="backup-restore-select__list">
                            <CheckboxGroup
                                className="backup-restore-select__checkbox"
                                value={selectedValues}
                                onChange={setSelectedValues}
                                options={visibleOptions}
                            />
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
