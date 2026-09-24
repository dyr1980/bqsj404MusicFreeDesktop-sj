// ============================================================================
// 歌词自动跟随滚动控制器
// ============================================================================
//
// 从 LyricPanel 抽出的滚动跟随逻辑，不依赖 React，可直接用真实 DOM 驱动验证。
//
// 需要解决的几个坑：
//   1. `scrollTo({ behavior: 'smooth' })` 在连续调用时会重定向正在进行的动画，
//      行为不确定；这里改成自己按帧缓动，每次从当前位置重新计时。
//   2. 用户滚动的宽限期内可能又换了好几行，宽限期一结束必须补滚，
//      否则高亮会永久停在画面外。
//   3. 宽限期内如果用户自己滚到了别处，到期后不能把视图抢回去。

/** 用户交互后暂停自动跟随时长 (ms) */
export const USER_SCROLL_PAUSE = 4000;
/** 居中滚动动画时长 (ms) */
export const SCROLL_ANIM_MS = 320;

/** 每帧走过的比例：缓出，起步快、收尾稳 */
function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/** 容器是否还有必要滚动所需要的最小信息 */
export interface ILyricScrollHost {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
}

export interface ILyricAutoScrollOptions {
    /** 暂停结束等需要 React 重渲染时回调 */
    onRerender: () => void;
    /** 是否禁用动画（prefers-reduced-motion） */
    reducedMotion?: boolean;
}

/** 计算把某个元素滚到容器垂直中心所需的位置，并钳制在可滚动范围内 */
export function resolveCenteringTarget(
    host: ILyricScrollHost,
    el: { offsetTop: number; offsetHeight: number },
): number {
    const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight);
    return Math.min(
        Math.max(el.offsetTop - host.clientHeight / 2 + el.offsetHeight / 2, 0),
        maxScroll,
    );
}

export default class LyricAutoScroll {
    private container: HTMLElement | null = null;
    private readonly onRerender: () => void;
    private readonly reducedMotion: boolean;

    /** 最后一次真正滚动跟随过的行号（暂停期间不更新） */
    private followedIndex = -1;
    /** 我们最近一次写进 scrollTop 的位置；用来把自家滚动和用户滚动区分开 */
    private selfScrollTop: number | null = null;
    /**
     * 用户最近一次自己滚动的时间戳（performance.now）。
     *
     * 只要还在 USER_SCROLL_PAUSE 窗口内，就尊重用户选的位置、不跟随播放进度；
     * 窗口一过自动恢复。用时间戳而不是布尔量，避免「用户滚过一次就永久不跟随」。
     */
    private lastUserScrollAt = Number.NEGATIVE_INFINITY;
    private paused = false;
    private pauseTimer: ReturnType<typeof setTimeout> | null = null;
    private animationFrame = 0;
    /** 动画卡死兜底计时 */
    private stuckTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: ILyricAutoScrollOptions) {
        this.onRerender = options.onRerender;
        this.reducedMotion = options.reducedMotion ?? false;
    }

    setContainer(container: HTMLElement | null): void {
        this.container = container;
    }

    get isPaused(): boolean {
        return this.paused;
    }

    /** 我们最后写进去的滚动位置（自家人判据），便于调试与测试 */
    get selfScrollPosition(): number | null {
        return this.selfScrollTop;
    }

    /**
     * 跟随播放进度：把高亮行滚到容器中心。
     *
     * @param activeIndex 当前高亮行号
     * @param selectorOf  由行号取到行元素
     */
    follow(activeIndex: number, selectorOf: (index: number) => HTMLElement | null): void {
        const container = this.container;
        if (!container || activeIndex < 0) return;
        if (activeIndex === this.followedIndex) return;
        // 用户刚自己滚过 → 这段时间内保持他选的位置
        if (performance.now() - this.lastUserScrollAt < USER_SCROLL_PAUSE) return;

        const el = selectorOf(activeIndex);
        if (!el) return;

        const first = this.followedIndex === -1;
        this.followedIndex = activeIndex;
        this.scrollTo(resolveCenteringTarget(container, el), first);
    }

    /**
     * 处理容器自身的 scroll 事件。
     *
     * 只把「用户造成的」滚动算作接管：我们自己写 scrollTop 产生的那些事件要跳过，
     * 否则每次自动跟随都会白白吃掉一个宽限期，节奏一快就再也不跟随了。
     * 判据是「当前位置是否等于我们最后写进去的值」——动画每帧都会更新该值，
     * 比一次性标志位稳（不会被漏消费或多消费）。
     */
    notifyScroll(): void {
        const container = this.container;
        if (!container) return;
        if (this.selfScrollTop !== null && Math.abs(container.scrollTop - this.selfScrollTop) < 1) {
            return;
        }
        this.lastUserScrollAt = performance.now();
    }

    /**
     * 歌词换了一套（搜索换词、关联歌词、切歌重载）。
     *
     * 必须把「已跟随过的行号」清空：新旧歌词的行号很可能撞上同一个数字，
     * 那样 follow() 会以为已经跟过了直接返回，视图就停在上一次的位置、
     * 不会滚到新歌词当前该高亮的那一行。
     */
    resetFollowed(): void {
        this.cancelAnimation();
        this.followedIndex = -1;
        this.selfScrollTop = null;
        this.lastUserScrollAt = Number.NEGATIVE_INFINITY;
    }

    /** 用户拖拽/滚轮接管滚动：停掉动画，并起算一个宽限期 */
    takeOver(): void {
        this.cancelAnimation();
        this.selfScrollTop = null;
        this.pause();
    }

    /** 暂停自动跟随；到点后回调 onRerender 触发一次补滚 */
    pause(delay = USER_SCROLL_PAUSE): void {
        this.paused = true;
        this.lastUserScrollAt = performance.now();
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
        }
        this.pauseTimer = setTimeout(() => {
            this.pauseTimer = null;
            this.paused = false;
            // 暂停期间可能已经换了好几行，靠这次重渲染补上
            this.onRerender();
        }, delay);
    }

    /** 立即恢复跟随（点一下歌词这类「非拖拽」交互） */
    resume(): void {
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
            this.pauseTimer = null;
        }
        this.paused = false;
        this.lastUserScrollAt = Number.NEGATIVE_INFINITY;
        this.onRerender();
    }

    destroy(): void {
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
            this.pauseTimer = null;
        }
        this.cancelAnimation();
        this.container = null;
    }

    // ─── 私有 ───

    private cancelAnimation(): void {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = 0;
        }
        if (this.stuckTimer !== null) {
            clearTimeout(this.stuckTimer);
            this.stuckTimer = null;
        }
    }

    private scrollTo(target: number, immediate: boolean): void {
        const container = this.container;
        if (!container) return;

        this.cancelAnimation();

        const start = container.scrollTop;
        const distance = target - start;
        if (immediate || this.reducedMotion || Math.abs(distance) < 1) {
            container.scrollTop = target;
            this.selfScrollTop = target;
            return;
        }

        const startTime = performance.now();
        // 兜底：窗口被遮挡/最小化时 rAF 会被节流甚至停发，动画会卡在半路不回来。
        // 超过动画时长好几倍仍未跑完就直接落位，保证长期运行不会越拖越偏。
        const stuckTimer = setTimeout(() => {
            this.animationFrame = 0;
            container.scrollTop = target;
            this.selfScrollTop = target;
        }, SCROLL_ANIM_MS * 4);

        const step = (now: number) => {
            const progress = Math.min(1, (now - startTime) / SCROLL_ANIM_MS);
            const value = start + distance * easeOutCubic(progress);
            container.scrollTop = value;
            this.selfScrollTop = value;
            if (progress < 1) {
                this.animationFrame = requestAnimationFrame(step);
            } else {
                this.animationFrame = 0;
                if (this.stuckTimer !== null) {
                    clearTimeout(this.stuckTimer);
                    this.stuckTimer = null;
                }
            }
        };
        this.stuckTimer = stuckTimer;
        this.animationFrame = requestAnimationFrame(step);
    }
}
