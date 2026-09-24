/**
 * 歌名 / 歌手的归一化比对键
 *
 * 为什么需要：同一首歌在不同插件、不同下载来源里，歌手写法经常不一样 —— 实测同一首
 * 《珊瑚海》就有三种：
 *   `周杰伦&Lara梁心颐`（酷我）、`周杰伦, Lara梁心颐`（QQ歌词/弥音QQ）、`周杰伦、Lara梁心颐`（元力KG）
 * 另外本地 mp3 的 ID3 标签还可能只写第一位歌手（`周杰伦`）。
 *
 * 只按原始字符串比对，「本地优先 / 云盘同名文件」就永远匹配不上。
 * 这里把歌名去标点、把歌手拆成「人」的集合排序后合并，
 * 分隔符与顺序不同也能对上。
 */

/** 歌手之间的分隔符（顺序无关，见 normalizeArtistKey） */
const ARTIST_SPLIT_RE = /[&、,，;；/／+＋|｜·・]|\s[-–—]\s/;

/** 比对时忽略的空白与标点 */
// eslint-disable-next-line no-useless-escape
const NOISE_RE = /[\s\u3000\-–—_.,，。！!？?'"“”‘’()（）\[\]【】&、/／+＋;；|｜]/g;

/** 归一化歌名：小写 + 去掉空白与标点 */
export function normalizeTitleKey(value: string | null | undefined): string {
    return String(value ?? '')
        .toLowerCase()
        .replace(NOISE_RE, '');
}

/**
 * 归一化歌手：按分隔符拆成多个「人」，各自去标点后**排序**再合并。
 *
 * `周杰伦&Lara梁心颐` / `周杰伦, Lara梁心颐` / `周杰伦、Lara梁心颐`
 * 都会归一成 `lara梁心颐,周杰伦`。
 */
export function normalizeArtistKey(value: string | null | undefined): string {
    return String(value ?? '')
        .split(ARTIST_SPLIT_RE)
        .map((part) => normalizeTitleKey(part))
        .filter(Boolean)
        .sort()
        .join(',');
}

/**
 * 归一化「歌名|歌手」键（= 作品键），用于跨插件/跨来源的同一首歌比对。
 *
 * 歌名归一化后为空时返回空串：没有歌名就算不出作品身份，
 * 否则一堆「歌名/歌手都缺失」的条目会全部落到同一个键 `|` 上，
 * 被当成同一首作品共享状态（歌词偏移、下载记录）。
 */
export function buildMediaNameKey(
    title: string | null | undefined,
    artist: string | null | undefined,
): string {
    const titleKey = normalizeTitleKey(title);
    if (!titleKey) return '';
    return `${titleKey}|${normalizeArtistKey(artist)}`;
}
