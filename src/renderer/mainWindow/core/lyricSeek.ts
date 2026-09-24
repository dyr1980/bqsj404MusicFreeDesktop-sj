/**
 * 歌词拖拽选时 — 纯计算部分
 *
 * 与 DOM 无关的几何/时间换算，抽出来是为了能脱离组件单独验证。
 * LyricPanel 负责读 DOM 与渲染，这里只负责算。
 */

/** 歌词行在滚动容器内的排版信息（单位 px，坐标相对容器内容盒） */
export interface ILyricLineMetrics {
    /** 歌词行号 */
    index: number;
    /** 相对容器内容盒顶部的偏移 */
    offsetTop: number;
    /** 行高 */
    offsetHeight: number;
}

/**
 * 定位准星所指的歌词行：滚动区域内垂直居中点落在哪一行。
 *
 * @param lines    按文档顺序排列的歌词行排版信息
 * @param centerY  中心点在容器内容盒内的 y 坐标（scrollTop + clientHeight / 2）
 * @returns        命中的行号；列表为空时返回 null。
 *                 中心点在首行之上时归首行（对标移动端：贴着顶部也总是有目标），
 *                 落在底部留白（所有行之后）时吸附到最后一行。
 */
export function resolveCrosshairIndex(lines: ILyricLineMetrics[], centerY: number): number | null {
    if (!lines.length) return null;

    for (const line of lines) {
        // 命中判据是「落在行内部」而非「不晚于行尾」，
        // 这样准星正好压在行边界上时会归到下面那一行
        if (centerY < line.offsetTop + line.offsetHeight) {
            return line.index;
        }
    }

    // 中心点落在底部留白里，吸附到最后一行
    return lines[lines.length - 1].index;
}

/**
 * 由歌词行时间推导 seek 目标。
 *
 * 偏移语义与 LyricManager 相反：解析时用 `position = currentTime + userOffset`
 * 查行，所以要让第 T 秒的行成为当前行，音频需定位到 `T - userOffset`。
 * 正值提前、负值延后。结果钳制在 [0, duration]。
 */
export function resolveSeekTime(time: number, userOffset: number, duration: number): number {
    const upper = Number.isFinite(duration) ? duration : Infinity;
    return Math.min(Math.max(time - userOffset, 0), upper);
}
