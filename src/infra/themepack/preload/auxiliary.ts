/**
 * themepack — 辅助窗口 Preload 层
 *
 * 极简实现：
 * - 启动时从 localStorage 读取缓存的 CSS 并同步注入
 * - 监听主题切换广播，重新加载缓存中的 CSS
 *
 * 不处理 iframe、blurHash、安装卸载等逻辑。
 * 辅助窗口无需调用任何 themepack API。
 *
 * 前提：Electron 中所有窗口共享同一 session/partition，
 * 因此 localStorage 在主窗口和辅助窗口之间是共享的。
 */
import { ipcRenderer } from 'electron';
import { THEMEPACK_STORAGE_KEY, THEMEPACK_STYLE_NODE_ID, IPC } from '../common/constant';

/**
 * 从 localStorage 读取缓存的 CSS 并注入到 <style> 节点。
 * 如果无缓存则移除已有的 <style> 节点。
 */
function injectCssFromCache(): void {
    let styleNode = document.getElementById(THEMEPACK_STYLE_NODE_ID) as HTMLStyleElement | null;

    const raw = localStorage.getItem(THEMEPACK_STORAGE_KEY);
    if (!raw) {
        styleNode?.remove();
        return;
    }

    try {
        const cache = JSON.parse(raw);
        if (!styleNode) {
            styleNode = document.createElement('style');
            styleNode.id = THEMEPACK_STYLE_NODE_ID;
            // preload 阶段文档可能还没解析出 <head>（此时 document.head 是 null，
            // 直接 appendChild 会抛错、主题永远注入不进去），等它出现再挂
            whenHeadReady((head) => head.appendChild(styleNode!));
        }
        styleNode.textContent = cache.css || '';
    } catch {
        styleNode?.remove();
    }
}

/** 等 <head> 可用后执行（preload 早于文档解析，head 可能还不存在） */
function whenHeadReady(callback: (head: HTMLHeadElement) => void): void {
    if (document.head) {
        callback(document.head);
        return;
    }

    const tryInject = () => {
        if (document.head) {
            callback(document.head);
        } else {
            // <head> 还没出现，下一帧再看
            requestAnimationFrame(tryInject);
        }
    };

    document.addEventListener(
        'DOMContentLoaded',
        () => {
            if (document.head) callback(document.head);
        },
        { once: true },
    );
    requestAnimationFrame(tryInject);
}

// ── 同步阶段：preload 加载时立即注入缓存的 CSS ──
injectCssFromCache();

// ── 监听主题切换广播 → 重新注入 ──
// 注意：这个注册必须在注入逻辑之外，否则注入一抛错就再也收不到切换广播
ipcRenderer.on(IPC.THEME_SWITCHED, () => {
    injectCssFromCache();
});
