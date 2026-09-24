/**
 * SourceIndicator — 播放栏里的「音源」小胶囊
 *
 * 平时显示当前**实际音源**（本地 / 云盘 / 插件名）；自动换源时变成进度 + 停止按钮。
 *
 * 为什么不做成横跨全宽的条：那会白占一整行高度。这里精简成一个胶囊，
 * 放在播放栏左块（封面+标题）和控制键之间的空位里。
 *
 * 注意：显示的是**实际音源**，不是歌曲条目的 platform（一首歌可能在 A 插件搜到，
 * 但真正播的是本地文件或云盘同名文件）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai/react';
import { Cloud, HardDrive, Loader2, Plug, Square } from 'lucide-react';
import {
    currentMusicAtom,
    currentSourceAtom,
    sourceSwitchAtom,
} from '@renderer/mainWindow/core/trackPlayer/store';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import './index.scss';

/** 换源结果展示时长 */
const RESULT_VISIBLE_MS = 4000;

export default function SourceIndicator() {
    const { t } = useTranslation();
    const currentMusic = useAtomValue(currentMusicAtom);
    const source = useAtomValue(currentSourceAtom);
    const switching = useAtomValue(sourceSwitchAtom);

    const [showResult, setShowResult] = useState(false);
    useEffect(() => {
        if (!switching?.result) {
            setShowResult(false);
            return;
        }
        setShowResult(true);
        const timer = setTimeout(() => setShowResult(false), RESULT_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [switching?.result]);

    if (!currentMusic) return null;

    const isSwitching = !!switching && !switching.result;
    const result = switching?.result;

    // ── 换源中 / 刚出结果 ──
    if (isSwitching || (result && showResult)) {
        const done = switching?.tried.length ?? 0;
        const total = switching?.total ?? 0;
        return (
            <div className="l-source-indicator is-switching">
                {isSwitching ? (
                    <Loader2 size={12} className="l-source-indicator__spin" />
                ) : (
                    <Plug size={12} />
                )}
                <span
                    className="l-source-indicator__text"
                    title={isSwitching ? undefined : result?.platform}
                >
                    {isSwitching
                        ? t('playback.source_switching_short', {
                              done,
                              total: Math.max(total, done),
                          })
                        : result?.aborted
                          ? t('playback.source_switch_aborted')
                          : result?.ok
                            ? t('playback.source_switch_ok_short', {
                                  platform: result.platform ?? '',
                              })
                            : t('playback.source_switch_failed_short')}
                </span>
                {isSwitching && (
                    <button
                        type="button"
                        className="l-source-indicator__stop"
                        title={t('playback.stop_switch_source')}
                        onClick={() => trackPlayer.stopAutoToggle()}
                    >
                        <Square size={9} />
                    </button>
                )}
            </div>
        );
    }

    // ── 平时 ──
    const kind = source?.kind;
    // 刚切到这首歌、音源还没取到：显示「获取音源中…」而不是上一首的音源
    if (kind === 'loading') {
        return (
            <div className="l-source-indicator is-switching">
                <Loader2 size={12} className="l-source-indicator__spin" />
                <span className="l-source-indicator__text">{t('playback.source_loading')}</span>
            </div>
        );
    }

    const label = !kind
        ? t('playback.source_unknown')
        : kind === 'local'
          ? t('playback.source_local')
          : kind === 'cloud'
            ? t('playback.source_cloud')
            : (source?.platform ?? t('playback.source_plugin'));

    const Icon = kind === 'local' ? HardDrive : kind === 'cloud' ? Cloud : Plug;

    return (
        <div className="l-source-indicator" title={t('playback.source_label', { source: label })}>
            <Icon size={12} />
            <span className="l-source-indicator__text">{label}</span>
        </div>
    );
}
