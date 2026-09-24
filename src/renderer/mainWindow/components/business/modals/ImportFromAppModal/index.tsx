import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Link2, Loader2 } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { useSortedSupportedPlugins } from '@infra/pluginManager/renderer/hooks';
import pluginManager from '@infra/pluginManager/renderer';
import './index.scss';

export interface ImportFromAppModalProps {
    close: () => void;
}

/** 探测并发上限：插件跑在主进程的 vm 沙箱里，并发太高会把主线程压住 */
const PROBE_CONCURRENCY = 4;
/** 单个插件的探测超时（插件调用本身没有超时，卡住会一直挂着） */
const PROBE_TIMEOUT = 10000;

/**
 * 「链接获取方式」的行定义。
 *
 * 手机 App 那一类下面有多行（不同 App 拿链接的方式不一样），平台名写在正文里；
 * 这些行都属于「手机 App」，所以共用左边一个标签。
 */
const GUIDE_ROWS: ReadonlyArray<{ labelKey: string; lineKeys: string[] }> = [
    {
        labelKey: 'import_guide_mobile_label',
        lineKeys: ['import_guide_mobile_l1', 'import_guide_mobile_l2', 'import_guide_mobile_l3'],
    },
    { labelKey: 'import_guide_web_label', lineKeys: ['import_guide_web'] },
];

type ProbeState = 'pending' | 'ok' | 'fail' | 'timeout';

interface IProbeResult {
    hash: string;
    platform: string;
    state: ProbeState;
    /** 成功时拿到的歌曲列表（确认时直接复用，不再重新导入） */
    items: IMusic.IMusicItem[];
}

/** 带超时地调用一个插件的 importMusicSheet */
async function probePlugin(
    plugin: IPlugin.IPluginDelegate,
    link: string,
): Promise<{ state: ProbeState; items: IMusic.IMusicItem[] }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            pluginManager.callPluginMethod({
                hash: plugin.hash,
                method: 'importMusicSheet',
                args: [link],
            }),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('probe-timeout')), PROBE_TIMEOUT);
            }),
        ]);
        const items = (
            Array.isArray(result) ? result : result ? [result] : []
        ) as IMusic.IMusicItem[];
        return { state: items.length > 0 ? 'ok' : 'fail', items };
    } catch (e) {
        const isTimeout = e instanceof Error && e.message === 'probe-timeout';
        return { state: isTimeout ? 'timeout' : 'fail', items: [] };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * ImportFromAppModal — 从其他软件导入歌单（一步到位）
 *
 * 流程：
 *   1. 直接给输入框 + 各平台「怎么拿链接」的综合介绍
 *   2. 确认后把链接同时丢给**所有**支持 importMusicSheet 的插件做探测
 *      （错配的插件都是本地判断，实测 0~5ms 就否掉了；命中的插件才会真去拉歌单）
 *   3. 有效来源按「谁先成功谁先显示」流式列出，选一个 → 直接进「添加到歌单」
 *
 * 探测拿到的歌曲列表会缓存下来给确认步骤复用，所以整个流程只拉一次歌单。
 */
export default function ImportFromAppModal({ close }: ImportFromAppModalProps) {
    const { t } = useTranslation();
    const plugins = useSortedSupportedPlugins('importMusicSheet');

    const [inputValue, setInputValue] = useState('');
    const [probing, setProbing] = useState(false);
    const [results, setResults] = useState<IProbeResult[]>([]);
    const [pickedHash, setPickedHash] = useState<string | null>(null);
    const [showGuide, setShowGuide] = useState(true);
    /** 每次探测一个代号，避免旧探测的结果污染新一次 */
    const probeToken = useRef(0);

    const running = probing;
    const okResults = useMemo(() => results.filter((r) => r.state === 'ok'), [results]);
    const doneCount = results.length;

    const handleProbe = useCallback(async () => {
        const link = inputValue.trim();
        if (!link || plugins.length === 0) return;

        const token = ++probeToken.current;
        setProbing(true);
        setResults([]);
        setPickedHash(null);
        setShowGuide(false);

        // 先把所有插件列成"待探测"，让用户马上看到在查哪些来源
        setResults(
            plugins.map(
                (p): IProbeResult => ({
                    hash: p.hash,
                    platform: p.platform,
                    state: 'pending',
                    items: [],
                }),
            ),
        );

        const queue = [...plugins];
        const worker = async () => {
            while (queue.length > 0) {
                const plugin = queue.shift()!;
                const { state, items } = await probePlugin(plugin, link);
                if (probeToken.current !== token) return; // 已经开了新一次探测
                setResults((prev) =>
                    prev.map((r) => (r.hash === plugin.hash ? { ...r, state, items } : r)),
                );
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(PROBE_CONCURRENCY, plugins.length) }, () => worker()),
        );

        if (probeToken.current === token) setProbing(false);
    }, [inputValue, plugins]);

    const handleConfirm = useCallback(() => {
        const picked = okResults.find((r) => r.hash === pickedHash) ?? okResults[0];
        if (!picked || picked.items.length === 0) return;
        close();
        showModal('AddMusicToSheetModal', { musicItems: picked.items });
    }, [okResults, pickedHash, close]);

    const hasPlugins = plugins.length > 0;

    return (
        <Modal
            open
            onClose={close}
            title={t('sheetShare.import_from_plugin')}
            className="import-from-app-modal"
            subtitle={
                <>
                    {/* 前半句加粗高亮：这是最需要用户知道的前提 */}
                    <strong className="import-from-app__desc-lead">
                        {t('sheetShare.import_desc_lead')}
                    </strong>
                    {t('sheetShare.import_desc_rest')}
                </>
            }
            size="md"
            footer={
                <>
                    <Button variant="secondary" onClick={close} disabled={running}>
                        {t('common.cancel')}
                    </Button>
                    {okResults.length === 0 ? (
                        <Button
                            variant="primary"
                            onClick={handleProbe}
                            loading={running}
                            disabled={!hasPlugins || !inputValue.trim()}
                        >
                            {t('common.confirm')}
                        </Button>
                    ) : (
                        <Button variant="primary" onClick={handleConfirm} disabled={running}>
                            {t('sheetShare.import_add_sheet')}
                        </Button>
                    )}
                </>
            }
        >
            <div className="import-from-app">
                <Input
                    prefix={<Link2 size={16} />}
                    placeholder={t('sheetShare.import_link_placeholder')}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    disabled={running}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && okResults.length === 0) handleProbe();
                    }}
                />

                {/* ── 链接获取方式 ── */}
                {showGuide && (
                    <div className="import-from-app__guide">
                        <div className="import-from-app__guide-title">
                            {t('sheetShare.import_guide_title')}
                        </div>
                        {GUIDE_ROWS.map(({ labelKey, lineKeys }) => (
                            <div key={labelKey} className="import-from-app__guide-row">
                                <span className="import-from-app__guide-platform">
                                    {t(`sheetShare.${labelKey}`)}
                                </span>
                                <span className="import-from-app__guide-text">
                                    {lineKeys.map((k) => (
                                        <span key={k}>{t(`sheetShare.${k}`)}</span>
                                    ))}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {/* ── 探测结果 ── */}
                {results.length > 0 && (
                    <div className="import-from-app__results">
                        <div className="import-from-app__results-title">
                            {probing
                                ? t('sheetShare.import_probing', {
                                      done: doneCount,
                                      total: plugins.length,
                                  })
                                : t('sheetShare.import_probe_done', {
                                      count: okResults.length,
                                  })}
                        </div>

                        {results
                            .filter((r) => r.state !== 'pending')
                            .map((r) => {
                                const isOk = r.state === 'ok';
                                const picked =
                                    isOk && (pickedHash ?? okResults[0]?.hash) === r.hash;
                                return (
                                    <button
                                        key={r.hash}
                                        type="button"
                                        className={`import-from-app__result${picked ? ' is-picked' : ''}`}
                                        disabled={!isOk}
                                        onClick={() => setPickedHash(r.hash)}
                                    >
                                        {isOk ? (
                                            <CheckCircle2 size={16} className="is-ok" />
                                        ) : (
                                            <AlertCircle size={16} className="is-fail" />
                                        )}
                                        <span className="import-from-app__result-name">
                                            {r.platform}
                                        </span>
                                        <span className="import-from-app__result-meta">
                                            {isOk
                                                ? t('sheetShare.import_song_count', {
                                                      count: r.items.length,
                                                  })
                                                : r.state === 'timeout'
                                                  ? t('sheetShare.import_probe_timeout')
                                                  : t('sheetShare.import_probe_invalid')}
                                        </span>
                                    </button>
                                );
                            })}

                        {results.some((r) => r.state === 'pending') && (
                            <div className="import-from-app__pending">
                                <Loader2 size={14} className="spin" />
                                {t('sheetShare.import_probing_hint')}
                            </div>
                        )}

                        {!probing && okResults.length === 0 && (
                            <div className="import-from-app__empty">
                                {t('sheetShare.import_no_valid_source')}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
