/**
 * shortCut — 渲染进程层
 *
 * 职责:
 *  1. 管理应用内（local）快捷键 — 基于 tinykeys 监听 DOM keydown
 *  2. 热更新：监听 appConfig 变更，自动重新绑定
 *  3. 暴露全局快捷键注册状态查询
 *  4. 快捷键触发时通过 appSync.sendCommand 派发指令
 *
 * NOTE:
 *  - 本模块仅处理配置化的 8 个 ShortCutAction
 *  - 组件级临时快捷键（如 Esc 关闭弹窗、Shift 多选）
 *    建议直接在组件中使用 tinykeys 绑定到特定 DOM 元素
 */
import { tinykeys } from 'tinykeys';
import type { IAppConfig, IAppConfigReader } from '@appTypes/infra/appConfig';
import type { ICommandSender } from '@appTypes/infra/appSync';
import type {
    IGlobalShortCutRegistration,
    IShortCutBinding,
    ShortCutAction,
} from '@appTypes/infra/shortCut';
import { electronAcceleratorToTinykeys } from './common/accelerator';
import { CONTEXT_BRIDGE_KEY } from './common/constant';

// ─── Preload Bridge ───

interface IMod {
    getGlobalShortCutStatus(): Promise<IGlobalShortCutRegistration[]>;
    onGlobalShortCutStatusChanged(
        callback: (registrations: IGlobalShortCutRegistration[]) => void,
    ): () => void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

// ─── 模块实现 ───

class ShortCutRenderer {
    private appConfig!: IAppConfigReader;
    private appSync!: ICommandSender;

    /** tinykeys 返回的取消绑定函数 */
    private unsubscribeLocal: (() => void) | null = null;

    /** 全局快捷键注册状态缓存 */
    private globalStatus: IGlobalShortCutRegistration[] = [];

    /** 状态变更监听回调 */
    private globalStatusCallbacks = new Set<
        (registrations: IGlobalShortCutRegistration[]) => void
    >();

    private isSetup = false;

    /**
     * 这一发按键是不是该归 DOM（不该被快捷键抢走）。
     *
     * 本地快捷键是**窗口级**的（tinykeys 挂在 window 上），不加判断会和下面这些抢按键：
     *   - 输入框 / 文本域：空格要能打空格（原本就有这条）
     *   - 滑条（音量 / 倍速）：↑↓ / PgUp / PgDn / Home / End 归滑条调值
     *
     * 方向键的其余情况由 `core/spatialFocus` 在 document 冒泡阶段处理：那里找到目标就
     * preventDefault + stopPropagation，事件根本到不了 window；找不到目标才轮到快捷键。
     */
    private static isDomOwnedKey(event: KeyboardEvent): boolean {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return false;

        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
            return true;
        }

        // 滑条 / 显式声明「按键归我」的区域
        return target.closest('[role="slider"], [data-roving-ignore]') !== null;
    }

    /**
     * 初始化，需在 appConfig 和 appSync renderer 层 setup 之后调用。
     */
    public setup(deps: { appConfig: IAppConfigReader; appSync: ICommandSender }) {
        if (this.isSetup) {
            return;
        }

        this.appConfig = deps.appConfig;
        this.appSync = deps.appSync;

        // 初次绑定 local 快捷键
        this.applyLocalShortcuts();

        // 监听配置变更，热更新
        this.appConfig.onConfigUpdated(this.handleConfigUpdated);

        // 订阅全局快捷键状态推送
        this.initGlobalStatusSync();

        this.isSetup = true;
    }

    // ─── 全局快捷键状态查询 ───

    /** 获取当前全局快捷键注册状态 */
    public async getGlobalShortCutStatus(): Promise<IGlobalShortCutRegistration[]> {
        this.globalStatus = await mod.getGlobalShortCutStatus();
        return this.globalStatus;
    }

    /** 监听全局快捷键状态变更 */
    public onGlobalShortCutStatusChanged(
        callback: (registrations: IGlobalShortCutRegistration[]) => void,
    ) {
        this.globalStatusCallbacks.add(callback);
    }

    /** 取消监听 */
    public offGlobalShortCutStatusChanged(
        callback: (registrations: IGlobalShortCutRegistration[]) => void,
    ) {
        this.globalStatusCallbacks.delete(callback);
    }

    /** 获取缓存的全局快捷键状态（同步） */
    public getCachedGlobalStatus(): IGlobalShortCutRegistration[] {
        return this.globalStatus;
    }

    // ─── 内部逻辑 ───

    private handleConfigUpdated = (patch: IAppConfig) => {
        const relevantKeys: string[] = ['shortCut.enableLocal', 'shortCut.shortcuts'];

        const hasRelevantChange = relevantKeys.some(
            (key) => key in (patch as Record<string, unknown>),
        );
        if (hasRelevantChange) {
            this.applyLocalShortcuts();
        }
    };

    /**
     * 根据当前配置绑定本地快捷键。
     * 先取消旧绑定，再全量重新绑定。
     */
    private applyLocalShortcuts() {
        // 取消之前的绑定
        this.unsubscribeLocal?.();
        this.unsubscribeLocal = null;

        const enableLocal = this.appConfig.getConfigByKey('shortCut.enableLocal');
        if (!enableLocal) {
            return;
        }

        const shortcutsMap = this.appConfig.getConfigByKey('shortCut.shortcuts');
        if (!shortcutsMap) {
            return;
        }

        const keyBindings: Record<string, (event: KeyboardEvent) => void> = {};

        const actions = Object.keys(shortcutsMap) as ShortCutAction[];
        for (const action of actions) {
            const binding: IShortCutBinding | undefined = shortcutsMap[action];
            if (!binding?.local?.length) {
                continue;
            }

            const accelerator = binding.local.join('+');
            if (!accelerator) {
                continue;
            }

            const tinykeysCombination = electronAcceleratorToTinykeys(accelerator);
            keyBindings[tinykeysCombination] = (event) => {
                // 输入框 / 滑条 / 焦点组自己管的按键不拦（见 isDomOwnedKey）
                if (ShortCutRenderer.isDomOwnedKey(event)) {
                    return;
                }
                event.preventDefault();
                this.appSync.sendCommand(action);
            };
        }

        if (Object.keys(keyBindings).length > 0) {
            this.unsubscribeLocal = tinykeys(window, keyBindings);
        }
    }

    private initGlobalStatusSync() {
        // 从主进程获取初始状态
        void this.getGlobalShortCutStatus();

        // 监听后续推送
        mod.onGlobalShortCutStatusChanged((registrations) => {
            this.globalStatus = registrations;
            for (const cb of this.globalStatusCallbacks) {
                cb(registrations);
            }
        });
    }
}

const shortCutRenderer = new ShortCutRenderer();
export default shortCutRenderer;
