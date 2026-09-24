import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ListFilter } from 'lucide-react';
import { cn } from '@common/cn';
import './index.scss';

export interface IHeaderFilterOption {
    value: string;
    label: string;
    /** 右侧计数（Excel 那种 `值 (n)`） */
    count?: number;
}

export interface HeaderFilterProps {
    /** 当前选中值 */
    value: string;
    options: IHeaderFilterOption[];
    onChange: (value: string) => void;
    /** 悬浮提示 */
    title?: string;
    /** 默认选项（显示为「全部」那种），默认是空串 */
    allValue?: string;
}

/**
 * HeaderFilter — 表头里的筛选按钮（参考 Excel：点列头上的小漏斗选值）
 *
 * 下拉用 portal 挂到 body（fixed 定位），所以在弹窗/表格里都不会被裁；
 * 有筛选生效时按钮高亮，一眼能看出这一列正在过滤。
 */
export function HeaderFilter({
    value,
    options,
    onChange,
    title,
    allValue = 'all',
}: HeaderFilterProps) {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState<{
        left: number;
        top: number;
        width: number;
        maxHeight: number;
    } | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const active = value !== allValue;

    const measure = useCallback(() => {
        const el = buttonRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const gap = 6;
        const below = vh - r.bottom - gap - 8;
        const above = r.top - gap - 8;
        const openUp = below < 140 && above > below;
        setRect({
            left: Math.min(r.left, window.innerWidth - 220),
            top: openUp ? Math.max(8, r.top - gap - Math.min(280, above)) : r.bottom + gap,
            width: 200,
            maxHeight: Math.max(120, Math.min(280, openUp ? above : below)),
        });
    }, []);

    useEffect(() => {
        if (!open) {
            setRect(null);
            return;
        }
        measure();
        const onScrollOrResize = () => measure();
        window.addEventListener('resize', onScrollOrResize);
        window.addEventListener('scroll', onScrollOrResize, true);
        return () => {
            window.removeEventListener('resize', onScrollOrResize);
            window.removeEventListener('scroll', onScrollOrResize, true);
        };
    }, [open, measure]);

    // 点外部关闭
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (buttonRef.current?.contains(target) || dropdownRef.current?.contains(target))
                return;
            setOpen(false);
        };
        window.addEventListener('mousedown', handler);
        return () => window.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className={cn('header-filter', active && 'is-active')}
                title={title}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}
            >
                <ListFilter size={13} />
            </button>
            {open &&
                rect &&
                createPortal(
                    <div
                        ref={dropdownRef}
                        className="header-filter__dropdown"
                        style={{
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            maxHeight: rect.maxHeight,
                        }}
                    >
                        {options.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={cn(
                                    'header-filter__option',
                                    opt.value === value && 'is-selected',
                                )}
                                onClick={() => {
                                    onChange(opt.value);
                                    setOpen(false);
                                }}
                            >
                                <span className="header-filter__check">
                                    {opt.value === value && <Check size={12} />}
                                </span>
                                <span className="header-filter__label">{opt.label}</span>
                                {opt.count !== undefined && (
                                    <span className="header-filter__count">{opt.count}</span>
                                )}
                            </button>
                        ))}
                    </div>,
                    document.body,
                )}
        </>
    );
}
