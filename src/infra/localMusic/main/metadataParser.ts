/**
 * localMusic — 元数据解析器
 *
 * 职责：
 * - 解析单个文件的 ID3/Vorbis 标签（音频元数据）
 * - **按作品键（归一化 歌名|歌手）解析文件身份**（v11 起与下载记录脱钩）
 * - 兜底使用文件名（`<歌名> - <歌手>` / 整名）作为标题
 *
 * 身份解析口径（为什么不再查 download_path 反查）：
 *   以前「App 下载的文件」要通过 `media_meta.download_path` 反查才能复用原插件
 *   的 platform/id，下载记录一被移除（文件保留），同一个文件就被算成 `本地` + md5(路径)，
 *   于是「本地音乐」里的条目和歌单/队列里的条目身份对不上，取源还得再靠下载记录兜。
 *   现在身份只跟「作品」走：库里出现过这个作品（media_meta / music_items / 已有本地行），
 *   就挂它的 platform/id；都没有才是真正的纯本地文件。
 */

import { createHash } from 'crypto';
import path from 'path';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import { buildMediaNameKey } from '@common/mediaNameKey';
import { parseAudioMeta } from '@infra/localMusic/common/parseAudioMeta';
import type { ILocalMusicItem } from '@appTypes/infra/localMusic';

/** 从文件名解析 `<歌名> - <歌手>`（与云盘 / 歌词文件名同规则：取最后一个分隔符） */
function parseFileName(fileName: string): { title: string; artist: string } {
    const idx = fileName.lastIndexOf(' - ');
    if (idx > 0) {
        return {
            title: fileName.slice(0, idx).trim(),
            artist: fileName.slice(idx + 3).trim(),
        };
    }
    return { title: fileName.trim(), artist: '' };
}

export interface IParseFileDeps {
    /**
     * 按作品键找已知条目身份。
     * @returns 命中时的 platform/id；null = 库里没有这个作品（纯本地文件）
     */
    findIdentityByWorkKey: (workKey: string) => { platform: string; id: string } | null;
    /** 按 platform + id 取库里的歌名/歌手（库里的信息通常比 ID3 完整） */
    lookupMusicItem?: (
        platform: string,
        id: string,
    ) => { title?: string | null; artist?: string | null } | null;
}

/**
 * 解析单个文件的元数据与身份。
 *
 * 1. 先解析 ID3/Vorbis 标签（含 CJK 编码修正），文件名只用来补缺口；
 * 2. 用「歌名 + 歌手」归一化成作品键，去库里找已知条目身份；
 * 3. 命中身份时用条目里的歌名/歌手覆盖标签值（下载来的文件 ID3 常缺歌手）；
 * 4. 找不到身份 → `本地` + md5(文件路径)，即真正的纯本地文件。
 */
export async function parseFileMetadata(
    filePath: string,
    fileSize: number,
    fileMtime: number,
    scanFolderId: string,
    deps: IParseFileDeps,
): Promise<ILocalMusicItem> {
    const parsed = path.parse(filePath);
    const folder = parsed.dir;

    // ─── 1. 标签优先，文件名补缺 ───
    const meta = await parseAudioMeta(filePath, { skipCovers: true, skipLyrics: true });
    const fromName = parseFileName(parsed.name);

    const title = meta.title?.trim() || fromName.title;
    const artist = meta.artist?.trim() || fromName.artist;

    // ─── 2. 作品键 → 已知身份 ───
    const workKey = buildMediaNameKey(title, artist);
    const identity = workKey ? deps.findIdentityByWorkKey(workKey) : null;

    // ─── 3. 命中身份：用库里的歌名/歌手补齐标签 ───
    const canonical = identity
        ? (deps.lookupMusicItem?.(identity.platform, identity.id) ?? null)
        : null;

    return {
        filePath,
        platform: identity?.platform ?? LOCAL_PLUGIN_NAME,
        id: identity?.id ?? createHash('md5').update(filePath).digest('hex'),
        title: canonical?.title?.trim() || title || parsed.name,
        artist: canonical?.artist?.trim() || artist || '',
        album: meta.album ?? '',
        duration: meta.duration ?? null,
        artwork: null,
        folder,
        fileSize,
        fileMtime: Math.floor(fileMtime),
        scanFolderId,
        createdAt: Date.now(),
        quality: null,
        source: 'scan',
    };
}
