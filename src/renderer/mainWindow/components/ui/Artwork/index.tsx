import { type HTMLAttributes, type ReactNode, useCallback, useState, useEffect } from 'react';
import { cn } from '@common/cn';
import { DefaultCover } from '@renderer/common/DefaultCover';
import { useCoverAllowed, type CoverKind } from '@renderer/common/coverLoad';
import './index.scss';

export type ArtworkSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

export interface ArtworkProps extends HTMLAttributes<HTMLDivElement> {
    /** 封面图片 URL */
    src?: string;
    /** alt 文字 */
    alt?: string;
    /** 圆角档位：sm(8px) | md(12px) | lg(24px) */
    rounded?: 'sm' | 'md' | 'lg';
    /** 尺寸预设 */
    size?: ArtworkSize;
    /** 自定义占位内容（当无 src 时显示；默认为黑白音符 DefaultCover） */
    fallback?: ReactNode;
    /** 悬浮覆盖层（如播放按钮） */
    overlay?: ReactNode;
    /**
     * 这张图属于哪一类封面。
     *
     * 传了就会受「设置 → 常规 → 封面加载」约束：该类封面被关掉时直接显示默认图，
     * 连图片请求都不发出（省流量）。不传 = 不受约束（如作者头像）。
     */
    coverKind?: CoverKind;
}

const ARTWORK_SIZES: Record<ArtworkSize, number> = {
    sm: 48,
    md: 120,
    lg: 200,
    xl: 320,
    auto: 0, // 由内容撑开，CSS 中设置 max-width: 100%
};

/**
 * Artwork — 原子组件
 *
 * 正方形封面容器，支持占位、hover overlay。
 * 加载失败时自动回退到默认封面图。
 */
export function Artwork({
    src,
    alt = '',
    rounded = 'md',
    size = 'md',
    fallback,
    overlay,
    coverKind,
    className,
    style,
    ...rest
}: ArtworkProps) {
    const dimension = ARTWORK_SIZES[size] || '100%';
    const [imgError, setImgError] = useState(false);
    /** 该分类的封面是否允许自动加载（关掉时不渲染图片，连请求都不发） */
    const coverAllowed = useCoverAllowed(coverKind ?? 'song');

    // src 变更时重置错误状态
    useEffect(() => {
        setImgError(false);
    }, [src]);

    const handleImgError = useCallback(() => {
        setImgError(true);
    }, []);

    // 实际显示的图片源：被策略关掉、或加载失败时，回退到默认封面
    const displaySrc = src && !imgError && (coverAllowed || !coverKind) ? src : undefined;
    /** 走默认封面（没有自定义 fallback）的那一档 */
    const isDefaultCover = !displaySrc && !fallback;

    const classNames = cn(
        'artwork',
        `artwork--${rounded}`,
        // 默认封面是「墨迹 + 透明底」，本身没有方块边界：
        // 去掉占位底色和阴影，让它直接融进主题背景
        isDefaultCover && 'artwork--default-cover',
        className,
    );

    return (
        <div
            className={classNames}
            style={{ width: dimension, height: dimension, ...style }}
            {...rest}
        >
            {displaySrc ? (
                <img
                    className="artwork__img"
                    src={displaySrc}
                    alt={alt}
                    loading="lazy"
                    draggable={false}
                    onError={handleImgError}
                />
            ) : fallback ? (
                <div className="artwork__fallback">{fallback}</div>
            ) : (
                // 默认占位：黑白音符 SVG，颜色继承 .artwork__fallback 的 --color-text-muted
                <div className="artwork__fallback">
                    <DefaultCover />
                </div>
            )}
            {overlay && <div className="artwork__overlay">{overlay}</div>}
        </div>
    );
}

export default Artwork;
