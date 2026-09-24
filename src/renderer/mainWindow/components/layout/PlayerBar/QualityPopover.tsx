// ============================================================================
// QualityPopover — 音质选择气泡面板
// ============================================================================
//
// 音质按钮 + 垂直列表面板。开关逻辑见 usePlayerPopover（hover / 键盘聚焦都能展开，
// 且面板收起时面板内的选项自动退出 Tab 序列）。
// 点击/回车选项切换当前播放音质，同时更新全局默认音质配置。

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@common/cn';
import { QUALITY_KEYS } from '@common/constant';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useQuality } from '@renderer/mainWindow/core/trackPlayer/hooks';
import appConfig from '@infra/appConfig/renderer';
import { showToast } from '../../ui/Toast';
import { usePlayerPopover } from './usePlayerPopover';

/** 音质 key → i18n key */
const QUALITY_I18N_KEYS: Record<IMusic.IQualityKey, string> = {
    low: 'quality.low',
    standard: 'quality.standard',
    high: 'quality.high',
    super: 'quality.super',
};

/** 从高到低排列，面板自上而下为高 → 低 */
const QUALITY_OPTIONS = [...QUALITY_KEYS].reverse();

/**
 * QualityPopover
 *
 * - hover 延迟 120ms 打开 / 200ms 关闭；键盘聚焦立即打开，焦点离开立即关闭
 * - 4 个选项从上到下：超高音质 → 高音质 → 标准音质 → 低音质
 * - 当前音质显示勾选标记与品牌色
 * - 键盘：面板展开后只有「当前焦点项」是一个 Tab 停靠点，↑↓ / Home / End 在列表内移动
 * - 点击/回车选项：切换当前播放音质 + 更新全局默认音质
 */
const QualityPopover = memo(function QualityPopover() {
    const quality = useQuality();
    const { t } = useTranslation();

    const { open, triggerRef, containerProps } = usePlayerPopover();

    /** 面板展开时，Tab 停靠点对齐到当前音质 */
    const activeIndex = Math.max(0, QUALITY_OPTIONS.indexOf(quality));
    const [focusIndex, setFocusIndex] = useState(activeIndex);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        if (open) setFocusIndex(activeIndex);
    }, [open, activeIndex]);

    // ── 选择音质 ──

    const handleSelect = useCallback(
        async (q: IMusic.IQualityKey) => {
            const success = await trackPlayer.setQuality(q);
            if (success) {
                appConfig.setConfig({ 'playMusic.defaultQuality': q });
            } else {
                showToast(t('quality.unavailable'), { type: 'warn' });
            }
        },
        [t],
    );

    // ── 面板内方向键导航（列表是竖向的，↑↓ 归它；←→ 留给外层快捷键） ──

    const handlePanelKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const count = QUALITY_OPTIONS.length;
            let next: number;
            switch (e.key) {
                case 'ArrowUp':
                    next = focusIndex - 1;
                    break;
                case 'ArrowDown':
                    next = focusIndex + 1;
                    break;
                case 'Home':
                    next = 0;
                    break;
                case 'End':
                    next = count - 1;
                    break;
                default:
                    return;
            }
            e.preventDefault();
            e.stopPropagation();
            const wrapped = ((next % count) + count) % count;
            setFocusIndex(wrapped);
            optionRefs.current[wrapped]?.focus();
        },
        [focusIndex],
    );

    /** 面板展开时，焦点还在触发按钮上也能直接 ↓/↑ 进列表 */
    const handleTriggerKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            e.stopPropagation();
            const count = QUALITY_OPTIONS.length;
            const index = e.key === 'ArrowUp' ? count - 1 : activeIndex;
            setFocusIndex(index);
            optionRefs.current[index]?.focus();
        },
        [activeIndex],
    );

    return (
        <div
            className="l-player-bar__popover-anchor l-player-bar__popover-anchor--no-ml"
            {...containerProps}
        >
            {/* 触发按钮 */}
            <button
                ref={triggerRef}
                className="l-player-bar__quality"
                type="button"
                data-roving-item
                title={t('quality.switch')}
                onKeyDown={open ? handleTriggerKeyDown : undefined}
            >
                {t(QUALITY_I18N_KEYS[quality])}
            </button>

            {/* 气泡面板 */}
            <div
                className={cn(
                    'l-player-bar__popover l-player-bar__popover--list',
                    open && 'is-visible',
                )}
                data-focus-nav="vertical"
                onKeyDown={handlePanelKeyDown}
            >
                {QUALITY_OPTIONS.map((q, index) => {
                    const isActive = q === quality;
                    return (
                        <button
                            key={q}
                            ref={(el) => {
                                optionRefs.current[index] = el;
                            }}
                            type="button"
                            className={cn('l-player-bar__quality-option', isActive && 'is-active')}
                            // 只在面板展开时，当前焦点项可 Tab 进入（收起时整个面板退出 Tab 序列）
                            tabIndex={open && index === focusIndex ? 0 : -1}
                            onClick={() => handleSelect(q)}
                        >
                            <span className="l-player-bar__quality-option-label">
                                {t(QUALITY_I18N_KEYS[q])}
                            </span>
                            {isActive && (
                                <Check size={12} className="l-player-bar__quality-option-check" />
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
});

export default QualityPopover;
