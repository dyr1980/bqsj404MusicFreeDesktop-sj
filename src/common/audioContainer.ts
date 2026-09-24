/**
 * audioContainer — 音频容器嗅探与扩展名选择（主进程共用）
 *
 * 为什么需要：音源的 `Content-Type` 经常和实际字节对不上（CDN 常见），
 * 而扩展名决定了远端/本地文件叫什么、别人（元数据解析、云盘列表过滤）怎么认它。
 * 规则统一为：**文件头嗅探 > URL 后缀 > Content-Type > 兜底**。
 *
 * 从 downloadManager/main/downloadTask 抽出来共用：「不落盘直传云端」也要靠它
 * 决定远端文件名（远端是 `歌名 - 歌手.ext`，扩展名不在白名单里云盘列表会直接看不见）。
 */

import { SUPPORTED_AUDIO_EXTS } from './constant';

/** MIME → 文件扩展名映射 */
export const MIME_TO_EXT: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'application/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
};

/**
 * 读文件头判断真实音频容器，返回对应扩展名（判断不出来返回 null）。
 *
 * 需要至少 12 个字节。
 */
export function sniffExtFromBuffer(buffer: Buffer | Uint8Array | null | undefined): string | null {
    if (!buffer || buffer.length < 12) return null;

    const ascii = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.length).toString('latin1');
    // MP4 / M4A / MOV 家族：.....ftyp
    if (ascii.slice(4, 8) === 'ftyp') return '.m4a';
    if (ascii.slice(0, 4) === 'fLaC') return '.flac';
    if (ascii.slice(0, 4) === 'OggS') return '.ogg';
    if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WAVE') return '.wav';
    // ID3v2 开头，或 MPEG 帧同步（11 个 1）
    if (ascii.slice(0, 3) === 'ID3') return '.mp3';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return '.mp3';
    return null;
}

/** URL 路径里的音频扩展名（拿不到 / 不在白名单返回 null） */
export function extFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const pathname = new URL(url).pathname;
        const dot = pathname.lastIndexOf('.');
        if (dot < 0) return null;
        const ext = pathname.slice(dot).toLowerCase();
        return SUPPORTED_AUDIO_EXTS.has(ext) ? ext : null;
    } catch {
        return null;
    }
}

/** Content-Type → 音频扩展名（不在白名单返回 null） */
export function extFromContentType(contentType: string | undefined): string | null {
    if (!contentType) return null;
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const ext = MIME_TO_EXT[mime];
    return ext && SUPPORTED_AUDIO_EXTS.has(ext) ? ext : null;
}

/**
 * 选一个「能用的」扩展名：嗅探 → URL → Content-Type → 兜底 `.mp3`。
 *
 * 只有落在 `SUPPORTED_AUDIO_EXTS` 白名单里的扩展名才算数 —— 云盘列表按白名单过滤，
 * 名字不在白名单等于文件传上去了却看不见。
 */
export function pickAudioExt(input: {
    sniffed?: string | null;
    contentType?: string;
    url?: string;
    fallback?: string;
}): string {
    const candidates = [
        input.sniffed ?? null,
        extFromUrl(input.url),
        extFromContentType(input.contentType),
    ];
    for (const candidate of candidates) {
        if (candidate && SUPPORTED_AUDIO_EXTS.has(candidate)) return candidate;
    }
    return input.fallback ?? '.mp3';
}
