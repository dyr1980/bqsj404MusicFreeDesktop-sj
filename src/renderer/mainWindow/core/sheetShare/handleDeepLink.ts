/**
 * musicfree://importSheet 深链的处理（渲染进程侧）
 *
 * 主进程只负责识别协议并把片段转发成 appSync 命令（见 src/main/core/deepLink.ts），
 * 真正的解码与 UI 编排都在渲染进程完成。
 */
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';

/**
 * 处理歌单导入深链。
 *
 * - 带片段（?d= / ?c=）：打开导入弹窗并把片段交给它，由弹窗负责解码与后续流程
 * - 只带总数（?n=）或不带参数：打开导入弹窗，让用户选图/粘贴
 */
export function handleSheetImportDeeplink(fragment?: string): void {
    showModal('ImportSharedSheetModal', fragment ? { fragment } : {});
}
