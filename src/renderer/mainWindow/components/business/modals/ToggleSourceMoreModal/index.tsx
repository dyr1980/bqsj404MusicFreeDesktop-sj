import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, HardDrive, Cloud } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Select } from '@renderer/mainWindow/components/ui/Select';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { cn } from '@common/cn';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import type { ITogglePair } from '@renderer/mainWindow/core/sourceToggle';
import {
    switchItemsToSource,
    type TSourceSwitchKind,
} from '@renderer/mainWindow/core/sourceSwitch';
import {
    mapWithConcurrency,
    searchMatchInPlugin,
    TOGGLE_SEARCH_CONCURRENCY,
} from '@renderer/mainWindow/core/sourceMatch';
import pluginManager from '@infra/pluginManager/renderer';
import './index.scss';

export interface ToggleSourceMoreModalProps {
    close: () => void;
    /** 待批量换源的歌曲列表 */
    musicItems: IMusic.IMusicItem[];
    /** 确认换源：由调用方把结果写回对应列表 */
    onConfirm: (pairs: ITogglePair[]) => void | Promise<void>;
}

/** 目标来源：某个插件 / 本地文件 / 云端 */
type TTarget = { kind: 'plugin'; hash: string } | { kind: 'local' } | { kind: 'cloud' };

/**
 * ToggleSourceMoreModal — 批量换源弹窗
 *
 * 通过 showModal('ToggleSourceMoreModal', { musicItems, onConfirm }) 命令式打开。
 * 目标有三类，和单曲换源弹窗保持一致：
 *   - 本地文件：把命中本地文件的歌切成「本地」来源（没命中的标未匹配，交给自动换源）
 *   - 云端：把云端有同名的歌切成「云端」来源
 *   - 插件：逐首在该插件里搜索并按匹配规则取最佳结果
 *
 * 搜索采用受限并发：批量选中上百首时若无限制地并行请求，会占满主进程
 * （所有 IPC 变慢、界面卡顿），也容易触发平台限流。
 */
export default function ToggleSourceMoreModal({
    close,
    musicItems,
    onConfirm,
}: ToggleSourceMoreModalProps) {
    const { t } = useTranslation();

    const plugins = useMemo(() => pluginManager.getSortedSearchablePlugins('music'), []);

    /** 可换源的歌曲（排除本地歌曲） */
    const toggleable = useMemo(
        () => musicItems.filter((item) => !!item.platform && !!item.title),
        [musicItems],
    );

    const [target, setTarget] = useState<TTarget>(
        plugins[0]?.hash ? { kind: 'plugin', hash: plugins[0].hash } : { kind: 'local' },
    );
    const [applying, setApplying] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });

    const options = useMemo(
        () => plugins.map((p) => ({ value: p.hash, label: p.platform })),
        [plugins],
    );

    /** 本地 / 云端的换源结果（纯计算，确认时才落库） */
    const handleConfirm = useCallback(async () => {
        if (applying || !toggleable.length) return;

        setApplying(true);
        setProgress({ done: 0, total: toggleable.length });

        try {
            // ── 本地文件 / 云端：一次比对完，没命中的也照换（标未匹配） ──
            if (target.kind === 'local' || target.kind === 'cloud') {
                const { items: next, matched } = await switchItemsToSource(
                    toggleable as unknown as IMusicItemSlim[],
                    target.kind,
                );
                const pairs: ITogglePair[] = next.map((item, i) => ({
                    old: {
                        platform: toggleable[i].platform,
                        id: String(toggleable[i].id),
                    },
                    new: item as unknown as IMusic.IMusicItem,
                }));

                await onConfirm(pairs);
                showToast(
                    t('music_toggle.more.result_switch', {
                        matched,
                        unmatched: pairs.length - matched,
                    }),
                    { type: matched > 0 ? 'info' : 'warn' },
                );
                close();
                return;
            }

            // ── 插件：逐首搜索匹配 ──
            const pluginHash = target.hash;
            const plugin = plugins.find((p) => p.hash === pluginHash);
            if (!plugin) return;

            // 已在目标插件的歌曲无需换源
            const pending = toggleable.filter((item) => item.platform !== plugin.platform);
            const skippedSameSource = toggleable.length - pending.length;

            let done = 0;
            const results = await mapWithConcurrency(
                pending,
                TOGGLE_SEARCH_CONCURRENCY,
                async (item) => {
                    const match = await searchMatchInPlugin(plugin, item, {
                        strictInterval: true,
                    });
                    done++;
                    setProgress({ done, total: pending.length });
                    return match
                        ? ({
                              old: { platform: item.platform, id: String(item.id) },
                              new: match,
                          } as ITogglePair)
                        : null;
                },
            );

            const pairs = results.filter((r): r is ITogglePair => r !== null);
            const noMatch = pending.length - pairs.length;

            if (!pairs.length) {
                showToast(t('music_toggle.more.no_match', { count: toggleable.length }), {
                    type: 'warn',
                });
                return;
            }

            await onConfirm(pairs);
            showToast(
                t('music_toggle.more.result', {
                    success: pairs.length,
                    skipped: skippedSameSource,
                    failed: noMatch,
                }),
            );
            close();
        } finally {
            setApplying(false);
        }
    }, [plugins, target, applying, toggleable, onConfirm, close, t]);

    const isSearching = applying && progress.total > 0;
    const isPluginTarget = target.kind === 'plugin';

    /** 本地 / 云端两条的说明文案 */
    const sourceHint = useCallback(
        (kind: TSourceSwitchKind) =>
            t(`music_toggle.more.${kind}_hint`, { count: toggleable.length }),
        [t, toggleable.length],
    );

    return (
        <Modal
            open
            onClose={close}
            title={t('music_toggle.more.title', { count: toggleable.length })}
            subtitle={t('music_toggle.more.subtitle')}
            size="sm"
            closeOnBackdrop={!applying}
            closeOnEscape={!applying}
            footer={
                <>
                    <Button variant="secondary" onClick={close} disabled={applying}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        icon={<RefreshCw size={16} />}
                        onClick={handleConfirm}
                        disabled={!toggleable.length || (target.kind === 'plugin' && !target.hash)}
                        loading={applying}
                    >
                        {t('music_toggle.more.confirm')}
                    </Button>
                </>
            }
        >
            <div className="b-toggle-source-more-modal">
                {/* ── 本地 / 云端（与单曲换源弹窗同一套语义） ── */}
                <div className="b-toggle-source-more-modal__sources">
                    {(
                        [
                            {
                                kind: 'local' as const,
                                label: t('music_toggle.source_local'),
                                icon: <HardDrive size={15} />,
                                hint: sourceHint('local'),
                            },
                            {
                                kind: 'cloud' as const,
                                label: t('music_toggle.source_cloud'),
                                icon: <Cloud size={15} />,
                                hint: sourceHint('cloud'),
                            },
                        ] as const
                    ).map((it) => (
                        <button
                            key={it.kind}
                            type="button"
                            className={cn(
                                'b-toggle-source-more-modal__source',
                                target.kind === it.kind && 'is-selected',
                            )}
                            disabled={applying}
                            onClick={() => setTarget({ kind: it.kind })}
                        >
                            <span className="b-toggle-source-more-modal__source-icon">
                                {it.icon}
                            </span>
                            <span className="b-toggle-source-more-modal__source-info">
                                <span className="b-toggle-source-more-modal__source-label">
                                    {it.label}
                                </span>
                                <span
                                    className="b-toggle-source-more-modal__source-hint"
                                    title={it.hint}
                                >
                                    {it.hint}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>

                {/* ── 插件 ── */}
                <div
                    className={cn(
                        'b-toggle-source-more-modal__row',
                        isPluginTarget && 'is-selected',
                    )}
                >
                    <span className="b-toggle-source-more-modal__label">
                        {t('music_toggle.more.select_plugin')}
                    </span>
                    <Select
                        value={target.kind === 'plugin' ? target.hash : ''}
                        onChange={(hash) => setTarget({ kind: 'plugin', hash })}
                        options={options}
                        placeholder={t('music_toggle.more.select_plugin')}
                        disabled={applying}
                    />
                </div>

                <p className="b-toggle-source-more-modal__hint">
                    {isSearching
                        ? t('music_toggle.more.searching', {
                              done: progress.done,
                              total: progress.total,
                          })
                        : isPluginTarget
                          ? t('music_toggle.more.hint')
                          : sourceHint(target.kind)}
                </p>

                {plugins.length === 0 && (
                    <p className="b-toggle-source-more-modal__warn">
                        {t('music_toggle.no_plugin')}
                    </p>
                )}
            </div>
        </Modal>
    );
}
