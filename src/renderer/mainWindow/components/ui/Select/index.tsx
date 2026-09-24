import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@common/cn';
import { OVERLAY_LAYER, registerOverlay } from '@renderer/mainWindow/core/overlay';
import './index.scss';

/** 下拉面板的浮层定位（fixed 挂在 body 上，避免被弹窗的 overflow:hidden 裁掉） */
interface IDropdownRect {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SelectOption {
    /** 选项值 */
    value: string;
    /** 显示文本 */
    label: string;
    /** 是否禁用 */
    disabled?: boolean;
}

export interface SelectProps {
    /** 当前选中值 */
    value: string;
    /** 选项列表 */
    options: SelectOption[];
    /** 值变化回调 */
    onChange?: (value: string) => void;
    /** 占位文本 */
    placeholder?: string;
    /** 是否禁用 */
    disabled?: boolean;
    /** 额外 className */
    className?: string;
}

/**
 * Select — 组合组件（自绘下拉）
 */
function Select({
    value,
    options,
    onChange,
    placeholder,
    disabled = false,
    className,
}: SelectProps) {
    const { t } = useTranslation();
    const resolvedPlaceholder = placeholder ?? t('common.select_hint');
    const [open, setOpen] = useState(false);
    const [menuRect, setMenuRect] = useState<IDropdownRect | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const selected = options.find((opt) => opt.value === value);

    /**
     * 量一次触发器位置，决定下拉往哪开、能开多高。
     *
     * 下拉面板用 `position: fixed` 挂到 body 上（见下面的 createPortal），
     * 这样弹窗、抽屉这类 `overflow: hidden` 的容器裁不到它；
     * 但也因此必须自己算坐标，并在滚动/改窗口大小时跟着更新。
     */
    const measure = useCallback(() => {
        const trigger = wrapperRef.current?.querySelector('.select__trigger') as HTMLElement | null;
        if (!trigger) return;
        const r = trigger.getBoundingClientRect();
        const vh = window.innerHeight;
        const gap = 8;
        const edge = 8;
        const spaceBelow = vh - r.bottom - gap - edge;
        const spaceAbove = r.top - gap - edge;
        // 下面放不下就往上开；上下都紧张时挑空间大的那边，最大高度按可用空间收
        const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(280, openUp ? spaceAbove : spaceBelow));
        setMenuRect({
            left: r.left,
            width: r.width,
            ...(openUp ? { bottom: vh - r.top + gap } : { top: r.bottom + gap }),
            maxHeight,
        });
    }, []);

    // ── 点击外部关闭（下拉已 portal 到 body，也要算「内部」） ──
    useEffect(() => {
        if (!open) return;

        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (wrapperRef.current?.contains(target) || dropdownRef.current?.contains(target)) {
                return;
            }
            setOpen(false);
        };

        window.addEventListener('mousedown', handler);
        return () => window.removeEventListener('mousedown', handler);
    }, [open]);

    // ── 打开 / 滚动 / 改窗口 → 重新定位 ──
    useEffect(() => {
        if (!open) {
            setMenuRect(null);
            return;
        }

        measure();
        const onScrollOrResize = () => measure();
        window.addEventListener('resize', onScrollOrResize);
        // 捕获阶段：任意祖先容器滚动都要跟着动
        window.addEventListener('scroll', onScrollOrResize, true);
        return () => {
            window.removeEventListener('resize', onScrollOrResize);
            window.removeEventListener('scroll', onScrollOrResize, true);
        };
    }, [open, measure]);

    // ── 打开时滚动到选中项 ──
    useEffect(() => {
        if (!open) return;
        // 等 DOM 渲染完成后再滚动
        requestAnimationFrame(() => {
            const el = dropdownRef.current?.querySelector('.is-selected');
            el?.scrollIntoView({ block: 'nearest' });
        });
    }, [open]);

    // ── ESC：注册给全局裁决（比弹窗更靠上：先关下拉，再按才关弹窗） ──
    useEffect(() => {
        if (!open) return;
        return registerOverlay({
            layer: OVERLAY_LAYER.popover,
            element: () => dropdownRef.current,
            close: () => setOpen(false),
        });
    }, [open]);

    const handleToggle = useCallback(() => {
        if (!disabled) setOpen((prev) => !prev);
    }, [disabled]);

    const handleSelect = useCallback(
        (optValue: string) => {
            onChange?.(optValue);
            setOpen(false);
        },
        [onChange],
    );

    const wrapperClassNames = cn('select', open && 'is-open', disabled && 'is-disabled', className);

    return (
        <div ref={wrapperRef} className={wrapperClassNames}>
            {/* ── 触发器 ── */}
            <button
                type="button"
                className="select__trigger"
                onClick={handleToggle}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span
                    className={cn('select__value', !selected && 'select__value--placeholder')}
                    title={selected?.label ?? resolvedPlaceholder}
                >
                    {selected?.label ?? resolvedPlaceholder}
                </span>
                <span className={cn('select__arrow', open && 'is-flipped')}>▼</span>
            </button>

            {/* ── 下拉面板（portal 到 body：弹窗里也不被裁、能完整展示选项） ── */}
            {open &&
                menuRect &&
                createPortal(
                    <div
                        ref={dropdownRef}
                        className="select__dropdown select__dropdown--portal"
                        role="listbox"
                        style={{
                            left: menuRect.left,
                            width: menuRect.width,
                            top: menuRect.top,
                            bottom: menuRect.bottom,
                            maxHeight: menuRect.maxHeight,
                        }}
                    >
                        {options.map((opt) => {
                            const isSelected = opt.value === value;
                            const optClassNames = cn(
                                'select__option',
                                isSelected && 'is-selected',
                                opt.disabled && 'is-disabled',
                            );

                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    className={optClassNames}
                                    disabled={opt.disabled}
                                    title={opt.label}
                                    onClick={() => handleSelect(opt.value)}
                                >
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>,
                    document.body,
                )}
        </div>
    );
}

export { Select };
