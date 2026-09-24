/**
 * pluginManager — getMediaSource 适配器（主进程）
 *
 * 在主进程中实现音质回退和重试逻辑：
 * 1. 按音质偏好顺序依次尝试
 * 2. 每个音质尝试 2 次（初次 + 150ms 延迟重试），但 4xx（429 除外）不重试
 * 3. normalizer 返回 null 表示该音质不可用，跳过重试直接下一个音质
 *
 * 此适配器在主进程运行，直接调用 callPluginMethod（无 IPC 开销）。
 */

import type {
    IGetMediaSourceParams,
    IGetMediaSourceResult,
    ICallPluginMethodParams,
} from '@appTypes/infra/pluginManager';
import { QUALITY_KEYS } from '@common/constant';
import delay from '@common/delay';

/** 调用插件方法的函数类型（由 PluginManager 注入） */
type CallPluginMethodFn = (params: ICallPluginMethodParams) => Promise<any>;

const RETRY_DELAY_MS = 150;

/**
 * 单次插件取源调用的超时时间。
 *
 * 插件内部的网络请求不受主进程控制，遇到死接口 / 挂住的系统代理时会**永久 pending**
 * （实测：启动恢复上次播放时卡死在 getMediaSource，导致渲染层 bootstrap 永不完成、
 *   界面只剩底色的「黑屏」）。这里给每次调用加硬超时，超时按普通失败处理：
 * 换下一个音质，最终返回 null，让上层走自动换源。
 */
const PLUGIN_CALL_TIMEOUT_MS = 15_000;

/**
 * 整次取源（所有音质 + 重试）的总时间预算。
 * 超过后直接返回 null，把控制权交回上层（例如自动换源），
 * 避免「插件接口挂住 → 每个音质各等 15s → 用户几分钟没反应」。
 */
const TOTAL_BUDGET_MS = 30_000;

/** 给 Promise 加超时保护 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * 构建音质尝试顺序。
 * 从请求的音质开始，按 qualityFallbackOrder 方向排列。
 */
function buildQualityOrder(
    requestedQuality: IMusic.IQualityKey,
    qualityOrder: IMusic.IQualityKey[],
    fallbackDirection: 'higher' | 'lower',
): IMusic.IQualityKey[] {
    const idx = QUALITY_KEYS.indexOf(requestedQuality);
    if (idx === -1) return [requestedQuality];

    const result: IMusic.IQualityKey[] = [requestedQuality];

    if (fallbackDirection === 'higher') {
        // 向高音质回退：从当前往上
        for (let i = idx + 1; i < QUALITY_KEYS.length; i++) {
            result.push(QUALITY_KEYS[i]);
        }
        // 然后向低音质
        for (let i = idx - 1; i >= 0; i--) {
            result.push(QUALITY_KEYS[i]);
        }
    } else {
        // 向低音质回退：从当前往下
        for (let i = idx - 1; i >= 0; i--) {
            result.push(QUALITY_KEYS[i]);
        }
        // 然后向高音质
        for (let i = idx + 1; i < QUALITY_KEYS.length; i++) {
            result.push(QUALITY_KEYS[i]);
        }
    }

    // 过滤出 qualityOrder 中包含的音质
    return result.filter((q) => qualityOrder.includes(q));
}

/** getMediaSource adapter 所需的参数（含 hash） */
export interface IGetMediaSourceAdapterParams extends IGetMediaSourceParams {
    /** 插件 hash */
    hash: string;
}

/**
 * 判断一次 getMediaSource 失败是否值得重试。
 *
 * 403 / 404 / 400 / 412 这类客户端错误重试不会有不同结果，只会白白翻倍请求量，
 * 还容易触发接口的 429 限流（实测很多音乐接口对高频请求会直接 429）。
 * 只有网络错误、超时、5xx、429 才值得再试一次。
 *
 * @returns true 表示值得重试
 */
function isRetryableError(err: any): boolean {
    const rawStatus =
        err?.response?.status ??
        err?.status ??
        err?.statusCode ??
        (typeof err?.message === 'string'
            ? Number(err.message.match(/status code (\d{3})/)?.[1])
            : undefined);

    const status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
    if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429) {
        return false;
    }
    return true;
}

/**
 * getMediaSource 适配器（主进程版本）。
 * 直接调用 callPluginMethod，无 IPC 开销。
 *
 * 流程：
 * - 按音质优先级顺序依次尝试
 * - 每个音质最多 2 次尝试（首次 + 150ms 延迟重试）
 * - normalizer afterCall 返回 null 表示该音质不可用，跳过重试直接下一个音质
 * - 网络/临时错误触发重试
 *
 * @param params 请求参数（含 hash）
 * @param callPluginMethod 调用插件方法的函数
 * @returns 媒体源结果（含实际音质），或 null
 */
export async function getMediaSourceAdapter(
    params: IGetMediaSourceAdapterParams,
    callPluginMethod: CallPluginMethodFn,
): Promise<IGetMediaSourceResult | null> {
    const { musicItem, quality, qualityOrder, qualityFallbackOrder, hash } = params;

    const orderedQualities = buildQualityOrder(quality, qualityOrder, qualityFallbackOrder);

    const startedAt = Date.now();
    const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

    for (const currentQuality of orderedQualities) {
        // 每个音质最多尝试 2 次
        for (let attempt = 0; attempt < 2; attempt++) {
            // 总预算用尽：直接放弃本次取源（上层会自动换源）
            const remaining = budgetLeft();
            if (remaining <= 0) {
                console.warn(
                    `[getMediaSource] 总预算 ${TOTAL_BUDGET_MS}ms 用尽，放弃取源: ${musicItem.platform}/${musicItem.id}`,
                );
                return null;
            }

            if (attempt > 0) {
                await delay(RETRY_DELAY_MS);
            }

            try {
                const result = await withTimeout(
                    callPluginMethod({
                        hash,
                        method: 'getMediaSource',
                        args: [musicItem, currentQuality],
                    }),
                    Math.min(PLUGIN_CALL_TIMEOUT_MS, remaining),
                    `getMediaSource(${musicItem.platform}/${musicItem.id}/${currentQuality})`,
                );

                // null/undefined 表示该音质不可用（normalizer 返回），跳到下一音质
                if (result === null || result === undefined) {
                    break;
                }

                if (result.url) {
                    return {
                        ...result,
                        quality: result.quality ?? currentQuality,
                    };
                }

                // 有返回值但无 url，也视为不可用
                break;
            } catch (err: any) {
                // 网络/临时错误，继续重试
                console.warn(
                    `[getMediaSource] Attempt ${attempt + 1} failed for quality ${currentQuality}:`,
                    err?.message ?? '',
                );

                // 403/404/400 等确定性失败：重试没有意义，直接换下一个音质
                if (!isRetryableError(err)) break;
            }
        }
    }

    return null;
}
