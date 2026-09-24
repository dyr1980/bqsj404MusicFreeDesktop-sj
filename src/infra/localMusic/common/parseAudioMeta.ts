/**
 * 共享的音频文件元数据解析函数。
 *
 * 统一 music-metadata 调用 + CJK 编码修正逻辑，
 * 供 localPlugin（导入）和 metadataParser（扫描）共同使用。
 */

import type { ICommonTagsResult, IPicture } from 'music-metadata';
import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import path from 'path';

/** 需要特殊处理的编码 */
const SPECIAL_ENCODINGS = new Set(['GB2312', 'GB18030', 'GBK', 'Big5']);

/** 扩展名 → MIME（用于判断「文件内容」和「扩展名」是否一致） */
const EXT_TO_MIME: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.mp4': 'audio/mp4',
    '.m4a': 'audio/mp4',
    '.m4s': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
};

/**
 * 读文件头判断真实容器，返回对应 MIME（判断不出来返回 null）。
 *
 * 为什么需要：下载下来的文件扩展名可能是错的（CDN 的 Content-Type 会撒谎）。
 * 例如一个其实是 M4A/AAC 的文件被存成 .mp3 时，music-metadata 会按 MPEG 帧去解析，
 * 时长解析成 0.01 秒这种垃圾值 —— 于是被「过滤短音频」挡掉，
 * 表现就是「下载完成了，本地音乐里却看不到」。
 */
async function sniffContainerMime(filePath: string): Promise<string | null> {
    try {
        const handle = await open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(16);
            const { bytesRead } = await handle.read(buffer, 0, 16, 0);
            if (bytesRead < 12) return null;

            const ascii = buffer.toString('latin1');
            if (ascii.slice(4, 8) === 'ftyp') return 'audio/mp4';
            if (ascii.slice(0, 4) === 'fLaC') return 'audio/flac';
            if (ascii.slice(0, 4) === 'OggS') return 'audio/ogg';
            if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
            if (ascii.slice(0, 3) === 'ID3') return 'audio/mpeg';
            if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
            return null;
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

export interface ParseAudioMetaOptions {
    /** 跳过封面提取（扫描场景可设为 true 以提升性能） */
    skipCovers?: boolean;
    /** 跳过歌词提取 */
    skipLyrics?: boolean;
}

export interface ParsedAudioMeta {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    /** base64 data URI，仅在 skipCovers 为 false 时可能有值 */
    artwork?: string;
    /** 原始歌词文本，仅在 skipLyrics 为 false 时可能有值 */
    rawLrc?: string;
}

function getB64Picture(picture: IPicture): string {
    return `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`;
}

/**
 * 检测并修正 CJK 元数据中的编码问题。
 * 部分音频文件的标签使用 GB2312 等编码写入，但 music-metadata 按 latin1 解析，
 * 导致标题/艺术家/专辑字段乱码，需要检测后重新解码。
 */
async function fixCJKEncoding(common: ICommonTagsResult): Promise<void> {
    const testFields = [common.title, common.artist, common.album];
    if (testFields.every((f) => !f)) return;

    const jschardet = await import('jschardet');
    let bestEncoding: string | null = null;
    let bestConfidence = 0;

    for (const field of testFields) {
        if (!field) continue;
        const result = jschardet.detect(field, { minimumThreshold: 0.4 });
        if (result.confidence > bestConfidence) {
            bestConfidence = result.confidence;
            bestEncoding = result.encoding;
        }
        if (bestConfidence > 0.9) break;
    }

    if (!bestEncoding || !SPECIAL_ENCODINGS.has(bestEncoding)) return;

    const iconv = await import('iconv-lite');
    const decode = (value: string) => iconv.decode(Buffer.from(value, 'latin1'), bestEncoding!);

    if (common.title) common.title = decode(common.title);
    if (common.artist) common.artist = decode(common.artist);
    if (common.album) common.album = decode(common.album);
    if (common.lyrics) {
        for (const lyric of common.lyrics) {
            if (lyric.text) lyric.text = decode(lyric.text);
        }
    }
}

/**
 * 解析音频文件的元数据（标题、艺术家、专辑、时长、封面、歌词）。
 *
 * 内部统一处理 CJK 编码修正。解析失败时返回空对象（由调用方决定 fallback）。
 */
export async function parseAudioMeta(
    filePath: string,
    options?: ParseAudioMetaOptions,
): Promise<ParsedAudioMeta> {
    const { skipCovers = false, skipLyrics = false } = options ?? {};

    try {
        const { parseFile, parseStream } = await import('music-metadata');

        // 扩展名和实际内容不一致时，按内容解析（扩展名会误导解析器选错分支）
        const mimeFromExt = EXT_TO_MIME[path.extname(filePath).toLowerCase()];
        const sniffedMime = await sniffContainerMime(filePath);
        const useContentSniff = !!sniffedMime && sniffedMime !== mimeFromExt;

        const metadata = useContentSniff
            ? await parseStream(createReadStream(filePath), sniffedMime, {
                  duration: true,
                  skipCovers,
              })
            : await parseFile(filePath, {
                  duration: true,
                  skipCovers,
              });
        const common = metadata?.common;
        if (!common) return {};

        await fixCJKEncoding(common);

        const result: ParsedAudioMeta = {};

        if (common.title) result.title = common.title;
        if (common.artist) result.artist = common.artist;
        if (common.album) result.album = common.album;
        if (metadata.format?.duration) result.duration = metadata.format.duration;

        if (!skipCovers && common.picture?.[0]) {
            result.artwork = getB64Picture(common.picture[0]);
        }

        if (!skipLyrics && common.lyrics?.length) {
            const lrc = common.lyrics.map((l) => l.text ?? '').join('');
            if (lrc) result.rawLrc = lrc;
        }

        return result;
    } catch {
        return {};
    }
}
