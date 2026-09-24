/**
 * SourceStateIcons — 「文件在哪」的状态图标
 *
 * 这两个图标是一对，出现在列表/播放条的下载按钮与云端按钮上：
 *   - `LocalFileIcon`   文件夹 + 对勾 → 本地已经有这个文件（已下载）
 *   - `CloudFileIcon`   云朵（线稿）+ 云内居中的向上箭头（待上传）/ 对勾（云端已有）
 *
 * 设计要点：
 *   - 一律线稿，和旁边的下载箭头、心形同一套视觉语言；云朵因为原图形是为实心设计的，
 *     线宽单独取 1.7（用 2 会显得比邻居粗）
 *   - 箭头/对勾画在云内、水平垂直居中
 */

interface IIconProps {
    size?: number | string;
    className?: string;
}

/**
 * 云朵轮廓（Material Symbols 的 cloud，描边渲染）。
 *
 * 这版的形状最接近 ☁️：左边一个大股 + 右边一个小股 + 平底，横向铺满 24 格
 * （x 1→23、y 4→20），所以缩到 16px 也不会比旁边的下载箭头显小。
 * 原始图形是给实心填充设计的，这里按线稿描边 → 线宽取 1.7（2 会显得过粗）。
 *
 * 导出给「歌词管理」的组合图标（云 + 右下角标）复用，保证全应用只有一朵云。
 */
export const CLOUD_PATH =
    'M6.5 20q-2.275 0-3.887-1.575T1 14.575q0-1.95 1.175-3.475T5.25 9.15q.625-2.3 2.5-3.725T12 4q2.925 0 4.962 2.037T19 11q1.725.2 2.863 1.488T23 15.5q0 1.875-1.312 3.188T18.5 20z';

/** 云朵轮廓的线宽（与 Material 原设计的笔画比例一致） */
export const CLOUD_STROKE = 1.7;

/** 云朵内、视觉居中的向上箭头（云体 y 10→20，箭头中心落在 14.3 附近） */
const UP_ARROW_PATH = 'M12 16.9V11.8M9.8 14l2.2-2.2 2.2 2.2';

/** 云朵内、视觉居中的对勾 */
const CHECK_IN_CLOUD_PATH = 'M9.5 14.7l2 2 3.6-4.2';

/** 文件夹 + 对勾：本地已经有这个文件（已下载） */
export function LocalFileIcon({ size = '100%', className }: IIconProps) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            <path d="m9 13 2 2 4-4" />
        </svg>
    );
}

/** 云朵（线稿）+ 云内居中的向上箭头（还没上传）/ 对勾（云端已有） */
export function CloudFileIcon({
    uploaded = false,
    size = '100%',
    className,
}: IIconProps & { uploaded?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={CLOUD_STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d={CLOUD_PATH} />
            <path d={uploaded ? CHECK_IN_CLOUD_PATH : UP_ARROW_PATH} />
        </svg>
    );
}
