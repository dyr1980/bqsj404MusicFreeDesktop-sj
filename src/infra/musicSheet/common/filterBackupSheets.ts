/**
 * 备份恢复的「范围 + 方式」决策（纯函数，零依赖，便于单测）
 *
 * 规则（简化后的流程）：
 * - **按单曲恢复**：挑出命中的单曲，统一导入一个**新歌单**（不会混进「我喜欢」，恢复完立刻能看到）
 * - **按歌单恢复**：
 *   - 追加 → 选中的歌单以新歌单形式追加（现有歌单不受影响）
 *   - 覆盖 → **只替换同名的现有歌单**，未选中的歌单保持不动
 * - **不带范围**（直接恢复整份备份）：
 *   - 追加 → 全部追加为新歌单
 *   - 覆盖 → 沿用历史行为：清空用户歌单后导入整份
 */
import type { IBackupSelection, IBackupSheet, RestoreMode } from '@appTypes/infra/backup';

/** 按单曲恢复时新歌单的兜底标题（渲染层会传本地化标题） */
export const DEFAULT_SINGLE_SHEET_TITLE = '云端恢复';

/** 与 @common/mediaKey 的 compositeKey 保持一致：platform + \0 + id */
function itemKey(platform: string, id: string): string {
    return `${platform}\0${String(id)}`;
}

export interface IFilteredBackup {
    /** 待导入的歌单（按单曲恢复时只含命中的单曲） */
    targetSheets: IBackupSheet[];
    /** 实际生效的模式（按单曲恢复一律按追加处理） */
    effectiveMode: RestoreMode;
    /** 覆盖模式 + 指定了歌单：只替换同名歌单，未选中的不动 */
    replaceByTitle: boolean;
    /** 只恢复单曲：全部导入 singleSheetTitle 这个新歌单 */
    singlesOnly: boolean;
    /** 单曲恢复的目标歌单标题 */
    singleSheetTitle: string;
}

export function filterBackupSheets(
    sheets: IBackupSheet[],
    mode: RestoreMode,
    selection?: IBackupSelection,
): IFilteredBackup {
    const allSheets = sheets ?? [];
    const selectedSheetIds = selection?.sheetIds?.length ? new Set(selection.sheetIds) : null;
    const selectedItemKeys = selection?.items?.length
        ? new Set(selection.items.map((it) => itemKey(it.platform, String(it.id))))
        : null;

    // ── 按单曲恢复 ──
    if (selectedItemKeys) {
        const targetSheets = allSheets
            .map((sheet) => ({
                ...sheet,
                musicList: (sheet.musicList ?? []).filter((item) =>
                    selectedItemKeys.has(itemKey(item.platform, String(item.id))),
                ),
            }))
            .filter((sheet) => sheet.musicList.length > 0);

        return {
            targetSheets,
            effectiveMode: 'append',
            replaceByTitle: false,
            singlesOnly: true,
            singleSheetTitle: selection?.singleSheetTitle?.trim() || DEFAULT_SINGLE_SHEET_TITLE,
        };
    }

    // ── 按歌单 / 整份 ──
    const targetSheets = selectedSheetIds
        ? allSheets.filter((sheet) => selectedSheetIds.has(sheet.id))
        : allSheets;
    const isOverwrite = mode === 'overwrite';

    return {
        targetSheets,
        effectiveMode: mode,
        replaceByTitle: isOverwrite && !!selectedSheetIds,
        singlesOnly: false,
        singleSheetTitle: '',
    };
}
