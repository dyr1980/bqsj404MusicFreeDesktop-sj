/**
 * 封面编辑（歌单 + 单曲）
 *
 * - 歌单（本地歌单）：写 musicSheet.updateSheet({ artwork })
 * - 单曲：写 mediaMeta（per-item 附加元数据，DB 存储 + 变更广播）
 *
 * 用户选的图统一做「正方形裁切 + 缩放到 512 + JPEG 压缩」再存成 dataURL：
 * 这样不用操心原图被移动/删除，也不会把几 MB 的原图塞进数据库。
 */
import { useCallback, useEffect, useState } from 'react';
import fsUtil from '@infra/fsUtil/renderer';
import i18n from '@infra/i18n/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import musicSheet from '@infra/musicSheet/renderer';
import { readFileAsDataUrl } from './sheetShare';

/** 自定义封面的边长（正方形） */
export const COVER_SIZE = 512;
/**
 * 「使用默认封面图」的哨兵值。
 *
 * 会存进 mediaMeta.artwork / 歌单 artwork 里，表示「不管歌曲/歌单自带什么封面，
 * 都显示内置的墨笔谱号默认图」。用一个不可能与 URL 撞车的固定字符串。
 */
export const DEFAULT_COVER = 'musicfree:default-cover';
/** JPEG 质量：512 见方下 0.86 基本看不出损失，体积约 60~120KB */
const COVER_QUALITY = 0.86;
/** 透明图转 JPEG 会丢 alpha，先铺一层深色底 */
const COVER_MATTE = '#121212';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

/**
 * 归一化封面值：哨兵值 / 空值都返回 undefined（= 交给默认封面图）。
 *
 * 显示侧统一走这里，避免把 'musicfree:default-cover' 当图片地址去加载。
 */
export function normalizeCover(value?: string | null): string | undefined {
    if (!value || value === DEFAULT_COVER) return undefined;
    return value;
}

/** 读成 HTMLImageElement（便于画到 canvas） */
function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = src;
    });
}

/** 正方形裁切（cover）+ 缩放 + 转 JPEG dataURL */
async function toSquareJpeg(dataUrl: string): Promise<string> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;

    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;

    ctx.fillStyle = COVER_MATTE;
    ctx.fillRect(0, 0, COVER_SIZE, COVER_SIZE);

    const scale = Math.max(COVER_SIZE / img.naturalWidth, COVER_SIZE / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (COVER_SIZE - w) / 2, (COVER_SIZE - h) / 2, w, h);

    return canvas.toDataURL('image/jpeg', COVER_QUALITY);
}

/**
 * 让用户选一张图片，返回处理好的 dataURL。
 *
 * @returns 用户取消或处理失败时返回 null
 */
export async function pickCoverDataUrl(): Promise<string | null> {
    const { canceled, filePaths } = await systemUtil.showOpenDialog({
        title: i18n.t('artwork.pick_title'),
        properties: ['openFile'],
        filters: [{ name: i18n.t('artwork.image_filter'), extensions: IMAGE_EXTS }],
    });
    if (canceled || !filePaths?.length) return null;

    const buffer = await fsUtil.readFile(filePaths[0]);
    const bytes =
        typeof buffer === 'string'
            ? new TextEncoder().encode(buffer)
            : new Uint8Array(buffer as unknown as ArrayBuffer);
    const raw = await readFileAsDataUrl(new Blob([bytes as unknown as BlobPart]));
    return toSquareJpeg(raw);
}

// ─── 单曲封面 ───

/** 缓存内的自定义封面（未预加载过时可能是 undefined，用 useSongCover 才有响应式保证） */
export function getSongCoverSync(platform: string, id: string): string | undefined {
    return mediaMeta.getMetaSync(platform, id)?.artwork ?? undefined;
}

/** 写入 / 清除单曲自定义封面 */
export async function setSongCover(
    platform: string,
    id: string,
    dataUrl: string | null,
    identity?: { title?: string; artist?: string },
): Promise<void> {
    await mediaMeta.setMeta(platform, id, { artwork: dataUrl }, identity);
}

/**
 * 订阅某首歌的自定义封面。
 *
 * mediaMeta 只有同步缓存 + 变更事件，没有 Hook，这里补一个：
 * 挂载时按需预加载一次，之后靠 setMeta 的广播保持同步。
 */
export function useSongCover(item?: { platform: string; id: string } | null): string | undefined {
    const platform = item?.platform;
    const musicId = item?.id != null ? String(item.id) : undefined;

    const read = useCallback(
        () => (platform && musicId ? getSongCoverSync(platform, musicId) : undefined),
        [platform, musicId],
    );

    const [cover, setCover] = useState<string | undefined>(read);

    useEffect(() => {
        setCover(read());
        if (!platform || !musicId) return;

        let alive = true;
        void mediaMeta.preload([{ platform, id: musicId }]).then(() => {
            if (alive) setCover(read());
        });

        const off = mediaMeta.onMetaChanged((event) => {
            if (event.platform === platform && String(event.musicId) === musicId) {
                setCover(event.meta?.artwork ?? undefined);
            }
        });

        return () => {
            alive = false;
            off();
        };
    }, [platform, musicId, read]);

    return cover;
}

// ─── 歌单封面 ───

/**
 * 写入本地歌单封面。
 *
 * @param dataUrl 传 null 表示恢复默认（库里置空，
 *                渲染侧会退回「最近一首歌的封面」或默认音符图）
 */
export async function setSheetCover(sheetId: string, dataUrl: string | null): Promise<void> {
    await musicSheet.updateSheet(sheetId, { artwork: dataUrl });
}
