import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard } from '../components/SettingsCard';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { A } from '@renderer/mainWindow/components/ui/A';
import systemUtil from '@infra/systemUtil/renderer';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { formatAppVersionDisplay } from '@common/version';

// ─── 本变体（fork） ───

/** 修改者 */
const FORK_MAINTAINER = '小橙子';

/**
 * 本变体的更新源 —— 指向你自己的仓库。
 *
 * 之后要启用「检查我的更新」时：把地址填到这里（例如
 * `https://raw.githubusercontent.com/<账号>/<仓库>/master/release/version.json`），
 * 同时把 `src/infra/systemUtil/common/constant.ts` 的 `FORK_UPDATE_SOURCES` 也填上。
 */
const FORK_UPDATE_SOURCE =
    'https://raw.githubusercontent.com/dyr1980/bqsj404MusicFreeDesktop-sj/main/release/version.json';

// ─── 本变体作者信息 ───

// 没有独立网站，指向你的 GitHub 主页
const UPSTREAM_SITE = 'https://github.com/dyr1980';
// 指向你的项目仓库
const UPSTREAM_REPO = 'https://github.com/dyr1980/bqsj404MusicFreeDesktop-sj';
// 没有 Bilibili，暂时指向 GitHub 主页
const BILIBILI_AUTHOR = 'https://github.com/dyr1980';
// 没有小红书，暂时指向 GitHub 主页
const XIAOHONGSHU_AUTHOR = 'https://github.com/dyr1980';

/**
 * 设置 → 关于
 *
 * 两张卡片：
 *   1. **关于 MusicFree**：本变体的版本号、修改者、（预留的）本变体更新
 *   2. **原版信息**：官网 / 仓库 / 获取更新 + 作者渠道
 */
export function AboutSection() {
    const { t } = useTranslation();
    const [updateStatus, setUpdateStatus] = useState<string>('');
    const [checking, setChecking] = useState(false);

    /** 检查更新（走本变体的更新源） */
    const handleCheckUpdate = useCallback(async () => {
        setChecking(true);
        setUpdateStatus('');
        try {
            const info = await systemUtil.checkUpdate();
            if (info.update) {
                showModal('UpdateModal', { updateInfo: info.update });
            } else {
                setUpdateStatus(t('settings.about.already_latest_v2'));
            }
        } catch {
            setUpdateStatus(t('settings.about.check_update_failed'));
        } finally {
            setChecking(false);
        }
    }, []);

    return (
        <>
            {/* ── 本变体 ── */}
            <SettingsCard
                title={t('settings.about.title')}
                subtitle={t('settings.about.subtitle')}
                action={
                    <div className="p-setting__action-row">
                        {!FORK_UPDATE_SOURCE && (
                            <span className="p-setting__action-hint">
                                {t('settings.about.fork_update_pending')}
                            </span>
                        )}
                        <Button
                            variant="secondary"
                            size="sm"
                            loading={checking}
                            onClick={handleCheckUpdate}
                        >
                            {t('settings.about.fork_update_btn')}
                        </Button>
                    </div>
                }
            >
                <div className="p-setting__about-grid">
                    <div className="p-setting__about-column">
                        <InfoRow
                            label={t('settings.about.current_version_label')}
                            value={formatAppVersionDisplay(globalContext.appVersion)}
                        />
                        <InfoRow
                            label={t('settings.about.modified_by_label')}
                            value={FORK_MAINTAINER}
                        />
                    </div>
                </div>
            </SettingsCard>

            {/* ── 原版信息 + 作者渠道 ── */}
            <SettingsCard
                title={t('settings.about.upstream_title')}
                subtitle={t('settings.about.upstream_subtitle')}
                action={
                    <div className="p-setting__action-row">
                        {updateStatus && (
                            <span className="p-setting__action-hint">{updateStatus}</span>
                        )}
                        <Button
                            variant="secondary"
                            size="sm"
                            loading={checking}
                            onClick={handleCheckUpdate}
                        >
                            {t('settings.about.check_update_btn')}
                        </Button>
                    </div>
                }
            >
                <div className="p-setting__about-groups">
                    {/* 项目信息 */}
                    <div className="p-setting__about-group">
                        <div className="p-setting__about-group-title">
                            {t('settings.about.upstream_project_label')}
                        </div>
                        <LinkRow
                            label={t('settings.about.official_site_link')}
                            text="小橙子"
                            url={UPSTREAM_SITE}
                        />
                        <LinkRow label="GitHub" text="MusicFreeDesktop" url={UPSTREAM_REPO} />
                    </div>

                    {/* 作者渠道（全部指向你的 GitHub） */}
                    <div className="p-setting__about-group">
                        <div className="p-setting__about-group-title">
                            {t('settings.about.contact_author_title')}
                        </div>
                        <InfoRow
                            label={t('settings.about.wechat_label')}
                            value="小橙子"
                        />
                        <LinkRow label="Bilibili" text="小橙子" url={BILIBILI_AUTHOR} />
                        <LinkRow
                            label={t('settings.about.xiaohongshu')}
                            text="小橙子"
                            url={XIAOHONGSHU_AUTHOR}
                        />
                    </div>
                </div>
            </SettingsCard>
        </>
    );
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="p-setting__info-row">
            <span className="p-setting__info-label">{label}</span>
            <span className="p-setting__info-value">{value}</span>
        </div>
    );
}

function LinkRow({ label, text, url }: { label: string; text: string; url: string }) {
    return (
        <div className="p-setting__info-row">
            <span className="p-setting__info-label">{label}</span>
            <A href={url}>{text}</A>
        </div>
    );
}
