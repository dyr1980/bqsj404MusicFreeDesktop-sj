/** IPC 通道 */
export const IPC = {
    // ─── App ───
    EXIT_APP: '@infra/system-util/exit-app',
    GET_CACHE_SIZE: '@infra/system-util/get-cache-size',
    CLEAR_CACHE: '@infra/system-util/clear-cache',
    CHECK_UPDATE: '@infra/system-util/check-update',

    // ─── Window ───
    MINIMIZE_WINDOW: '@infra/system-util/minimize-window',
    SHOW_MAIN_WINDOW: '@infra/system-util/show-main-window',
    TOGGLE_MAXIMIZE: '@infra/system-util/toggle-maximize',
    TOGGLE_VISIBLE: '@infra/system-util/toggle-visible',
    IGNORE_MOUSE_EVENT: '@infra/system-util/ignore-mouse-event',
    ENTER_MINIMODE: '@infra/system-util/enter-minimode',
    EXIT_MINIMODE: '@infra/system-util/exit-minimode',
    TOGGLE_MINIMODE: '@infra/system-util/toggle-minimode',

    // ─── Shell ───
    OPEN_EXTERNAL: '@infra/system-util/open-external',
    OPEN_PATH: '@infra/system-util/open-path',
    SHOW_ITEM_IN_FOLDER: '@infra/system-util/show-item-in-folder',

    // ─── Dialog ───
    SHOW_OPEN_DIALOG: '@infra/system-util/show-open-dialog',
    SHOW_SAVE_DIALOG: '@infra/system-util/show-save-dialog',

    // ─── Menu ───
    POPUP_NATIVE_MENU: '@infra/system-util/popup-native-menu',
} as const;

// ─── Update Sources ───

/**
 * **原版（上游）** 的版本检查源列表（按优先级排列）。
 * 都指向原作者猫头猫的官方地址：作者自建接口 + gitee/github 及其镜像。
 */
export const UPSTREAM_UPDATE_SOURCES = [
    'http://musicfree.v1v.fun/version/desktop.json',
    'https://gitee.com/maotoumao/MusicFreeDesktop/raw/master/release/version.json',
    'https://cdn.jsdelivr.net/gh/maotoumao/MusicFreeDesktop@master/release/version.json',
    'https://gh-proxy.org/https://raw.githubusercontent.com/maotoumao/MusicFreeDesktop/master/release/version.json',
    'https://raw.githubusercontent.com/maotoumao/MusicFreeDesktop/master/release/version.json',
    'https://hk.gh-proxy.org/https://raw.githubusercontent.com/maotoumao/MusicFreeDesktop/master/release/version.json',
    'https://cdn.gh-proxy.org/https://raw.githubusercontent.com/maotoumao/MusicFreeDesktop/master/release/version.json',
];

/**
 * **本变体（fork）** 的版本检查源 —— 仓库地址还没定，先留空。
 *
 * 之后要做「检查我的更新」时，需要两步：
 *   1. 把本变体的 version.json 地址填进这个数组（例如
 *      `https://raw.githubusercontent.com/<你的账号>/<仓库>/master/release/version.json`）；
 *   2. 在 `src/renderer/mainWindow/pages/SettingPage/sections/AboutSection.tsx` 里
 *      把 `FORK_UPDATE_SOURCE` 也填上，并去掉那个按钮的 disabled。
 */
export const FORK_UPDATE_SOURCES: string[] = [];

/** contextBridge key */
export const CONTEXT_BRIDGE_KEY = '@infra/system-util';
