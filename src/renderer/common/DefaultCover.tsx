/**
 * DefaultCover — 无封面时的默认图（墨笔高音谱号）
 *
 * 素材是一张「黑墨 + 透明底」的谱号图（含五线谱碎片与泼墨），但它不能直接当
 * 图片用：黑墨放在暗色主题上等于看不见。所以这里把它当作 **alpha mask**：
 *   - 素材的 alpha 是按「墨的深浅」生成的（黑墨=实、淡墨=半透明、底=透明）
 *   - 颜色由 `background-color: currentColor` 给，继承外层容器的
 *     `--color-text-muted`（浅色主题会把它覆盖成深色）
 * 这样同一份资源在暗色 / 浅色 / 纯黑三套主题下都是对的颜色，且没有背景色。
 *
 * 素材放在 `res/default-cover.png`（主进程的额外资源目录）而不是 src/assets：
 * 托盘菜单 / 任务栏缩略图的默认封面用的是同一张图（主进程读盘拿它，见
 * main/core/coverBitmap.ts），只留一份就不会出现「换了图但只换了一边」。
 */
import defaultCoverMask from '@res/default-cover.png';
import { cn } from '@common/cn';
import './DefaultCover.scss';

export function DefaultCover({ className }: { className?: string }) {
    return (
        <span
            className={cn('default-cover', className)}
            style={{
                WebkitMaskImage: `url(${defaultCoverMask})`,
                maskImage: `url(${defaultCoverMask})`,
            }}
            aria-hidden="true"
        />
    );
}

export default DefaultCover;
