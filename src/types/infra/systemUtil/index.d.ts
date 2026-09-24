/**
 * 版本更新信息
 */
export interface IUpdateInfo {
    /** 当前应用版本号 */
    version: string;
    /** 如果有可用更新，包含更新详情 */
    update?: {
        /** 新版本号 */
        version: string;
        /** 更新日志 */
        changeLog?: string[];
        /** 下载链接 */
        download?: string[];
    };
}

/** 系统原生菜单的一项（渲染进程无法把回调交给主进程，所以只传 id + 文案） */
export interface INativeMenuItem {
    /** 唯一标识；点击后原样回传给渲染进程 */
    id?: string;
    /** 菜单项文字 */
    label?: string;
    /** 分隔线 */
    type?: 'separator';
    /** 是否禁用 */
    enabled?: boolean;
}

/** 弹出系统原生菜单的参数 */
export interface IPopupNativeMenuParams {
    items: INativeMenuItem[];
    /** 屏幕坐标（DIP），不传则用鼠标当前位置 */
    x?: number;
    y?: number;
    /**
     * 在哪个窗口上弹出。
     *
     * 迷你窗口只有 420×120 装不下整份菜单，所以由主窗口的渲染进程构建菜单内容、
     * 但要弹在迷你窗口上，这里用来指定目标窗口。
     */
    targetWindow?: 'main' | 'minimode' | 'lyric' | 'sender';
}
