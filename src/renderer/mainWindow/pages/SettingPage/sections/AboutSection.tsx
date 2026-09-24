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
const FORK_MAINTAINER = '不甚解';

/**
 * 本变体的更新源 —— **仓库地址还没定**，先留空。
 *
 * 之后要启用「检查我的更新」时：把地址填到这里（例如
 * `https://raw.githubusercontent.com/<账号>/<仓库>/master/release/version.json`），
 * 同时把 `src/infra/systemUtil/common/constant.ts` 的 `FORK_UPDATE_SOURCES` 也填上，
 * 并把下面那个按钮的 `disabled` 去掉。
 */
const FORK_UPDATE_SOURCE = '';

// ─── 原版（上游）与原作者 ───

const UPSTREAM_SITE = 'https://musicfree.catcat.work';
const UPSTREAM_REPO = 'https://github.com/maotoumao/MusicFreeDesktop';
const BILIBILI_AUTHOR = 'https://space.bilibili.com/12866223';
const XIAOHONGSHU_AUTHOR =
    'https://www.xiaohongshu.com/user/profile/5ce6085200000000050213a6?xhsshare=CopyLink&appuid=5ce6085200000000050213a6&apptime=1714394544';

/**
 * 设置 → 关于
 *
 * 两张卡片：
 *   1. **关于 MusicFree**：本变体的版本号、修改者、（预留的）本变体更新
 *   2. **原版信息**：原版官网 / 原版仓库 / 获取原版更新 + 原作者的公众号、Bilibili、小红书
 *      （原来「原版信息」和「联系作者」是两张卡，信息量都不大，合并成一张更紧凑；
 *        微信公众号原来是一张推广二维码图，已改成和其它渠道一样的文字行）
 *
 * 本变体只会传到自己的仓库，所以这里不出现「本变体仓库 / Issues」这类指向原仓库的链接。
 */
export function AboutSection() {
    const { t } = useTranslation();
    const [updateStatus, setUpdateStatus] = useState<string>('');
    const [checking, setChecking] = useState(false);

    /** 检查原版更新（源是原作者的官方地址，见 systemUtil/common/constant.ts） */
    const handleCheckUpstreamUpdate = useCallback(async () => {
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
                            disabled={!FORK_UPDATE_SOURCE}
                            title={t('settings.about.fork_update_hint')}
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

            {/* ── 原版信息 + 原作者渠道 ── */}
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
                            onClick={handleCheckUpstreamUpdate}
                        >
                            {t('settings.about.check_update_btn')}
                        </Button>
                    </div>
                }
            >
                <div className="p-setting__about-groups">
                    {/* 原版项目 */}
                    <div className="p-setting__about-group">
                        <div className="p-setting__about-group-title">
                            {t('settings.about.upstream_project_label')}
                        </div>
                        <LinkRow
                            label={t('settings.about.official_site_link')}
                            text="musicfree.catcat.work"
                            url={UPSTREAM_SITE}
                        />
                        <LinkRow label="GitHub" text="MusicFreeDesktop" url={UPSTREAM_REPO} />
                    </div>

                    {/* 原作者 */}
                    <div className="p-setting__about-group">
                        <div className="p-setting__about-group-title">
                            {t('settings.about.contact_author_title')}
                        </div>
                        <InfoRow
                            label={t('settings.about.wechat_label')}
                            value={t('settings.about.wechat_handle')}
                        />
                        <LinkRow label="Bilibili" text="@不想睡觉猫头猫" url={BILIBILI_AUTHOR} />
                        <LinkRow
                            label={t('settings.about.xiaohongshu')}
                            text="@一只猫头猫"
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
