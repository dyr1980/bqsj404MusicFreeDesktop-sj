/**
 * 歌单分享编解码器
 *
 * 职责：把一份歌单压缩成可放进二维码的文本片段，并能从任意片段集合中还原出完整歌单。
 *
 * 设计要点：
 * 1. payload 直接用 UTF-8 文本 + 不可见控制字符分隔（v2）；
 *    早期版本用 base64url(JSON)，会让体积白白膨胀 33%——中文 UTF-8 本身已经很紧凑；
 * 2. 以「行」为歌曲单位，省掉 JSON 的 key 与括号（一首歌从 ~110 字节降到 ~39 字节）；
 * 3. 超长歌单切分成多个片段，每个片段自带序号和总数，且按 UTF-8 字符边界切；
 * 4. 全量校验 CRC32，避免二维码识别错误导致导入残缺歌单。
 *
 * 容量参考（QR byte 模式，纠错等级 L）：
 * - 单片段上限 FRAGMENT_BYTE_LIMIT = 1500 字节。这个值不是 QR 的理论上限
 *   （版本 40 约 2953 字节），而是**读取端**的限制：二维码在长图里按 159 CSS px
 *   @2x 渲染 = 318 设备像素，1500 字节约 109 个模块，仍有 2.86 px/模块，
 *   在实测安全线（2.8）之上。
 * - payload 直接放 UTF-8 文本（见 packSheet），不做 base64url：
 *   中文歌名/歌手用 UTF-8 已经很紧凑，base64url 会白白膨胀 33%。
 *   实测每首约 39 字节（中文歌名+歌手+数字 id），即单码约 26 首。
 */

/** 单片段建议最大字节数（encode 不会截断数据，只是用它决定切分粒度） */
export const FRAGMENT_BYTE_LIMIT = 1500;

/**
 * 协议版本。
 * v2 起 payload 改为 UTF-8 文本 + 分隔符（v1 是 base64url 的 JSON 数组）。
 * 两种格式的前缀不同（MFS1: / MFS2:），因此不会互相误读。
 */
export const CODEC_VERSION = 2;

/** 头部里「正文 UTF-8 字节数」字段的宽度（base36，4 位足够表达 1500 字节） */
const BODY_LENGTH_DIGITS = 4;
/** 头部里「正文校验和」字段的宽度 */
const CHECKSUM_DIGITS = 8;

/** 片段前缀，用于从自由文本中提取片段。v2 与 v1（MFS1:）不同，不会互相误读 */
const FRAGMENT_PREFIX = 'MFS2:';

/**
 * 片段格式（v2）：
 *
 *   MFS2:<index>/<total>:<checksum>:<bodyByteLength>:<body>
 *
 * 前三个字段是定长/定字符集的，能轻松解析；正文必须显式给出长度——
 * 因为正文是任意 UTF-8 文本（可能含换行、冒号、控制字符），
 * 靠字符集或行边界判断结束位置都不可靠（早期版本就因此完全解析不出片段）。
 */
function buildFragment(
    index: number,
    total: number,
    checksum: string,
    body: string,
    bodyByteLength: number,
): string {
    return `${FRAGMENT_PREFIX}${index}/${total}:${checksum}:${bodyByteLength
        .toString(36)
        .padStart(BODY_LENGTH_DIGITS, '0')}:${body}`;
}

/**
 * 单份歌单允许的最大片段数。
 *
 * 既是安全上限（避免被构造成 "MFS2:1/999999:..." 拖死），
 * 也是产品上限：按每片约 35 首算，256 片远超任何真实歌单。
 */
export const MAX_FRAGMENT_COUNT = 256;

/** 歌单分享的深链协议头 */
export const SHEET_DEEPLINK_PREFIX = 'musicfree://importSheet';

interface MusicItemLike {
    title?: string;
    artist?: string;
    id?: string;
    platform?: string;
}

export interface SheetLike {
    title?: string;
    artist?: string;
    platform?: string;
    description?: string;
    /** 封面图（不参与编解码，仅用于渲染长图） */
    artwork?: string;
    /** 部分来源用 coverImg 存封面 */
    coverImg?: string;
    musicList?: MusicItemLike[];
}

/** 编解码过程中出现的错误类型 */
export type DecodeErrorCode =
    /** 不是可识别的片段 */
    | 'NOT_A_FRAGMENT'
    /** base64 / JSON 解析失败，通常是二维码识别错误 */
    | 'MALFORMED'
    /** 版本号不认识 */
    | 'UNSUPPORTED_VERSION'
    /** CRC 校验不通过 */
    | 'CHECKSUM_MISMATCH';

export type DecodeFragmentResult =
    | {
          status: 'ok';
          index: number;
          total: number;
          payload: SheetLike;
          /** 本次解码新出现的分片数 */
          received: number;
      }
    | {
          status: 'incomplete';
          index: number;
          total: number;
          /** 已经收齐的片数 */
          received: number;
      }
    | {
          status: 'error';
          code: DecodeErrorCode;
      };

// ────────────────────────────────────────────────────────────────────────────
// CRC32
// ────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; ++i) {
        let c = i;
        for (let k = 0; k < 8; ++k) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

/** 计算字符串（UTF-8 字节）的 CRC32，返回 8 位小写十六进制 */
export function crc32(input: string): string {
    const bytes = utf8Encode(input);
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; ++i) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    return crc.toString(16).padStart(8, '0');
}

// ────────────────────────────────────────────────────────────────────────────
// UTF-8
// ────────────────────────────────────────────────────────────────────────────

function utf8Encode(str: string): Uint8Array {
    return new TextEncoder().encode(str);
}

function utf8Decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

// ────────────────────────────────────────────────────────────────────────────
// payload 结构（v2：UTF-8 文本 + 控制字符分隔）
//
// 为什么要用控制字符而不是 base64url + JSON：
//   JSON 数组 + base64url 会让体积膨胀 33%（中文 UTF-8 明明已经很紧凑），
//   实测每首 63 字节；改成 UTF-8 文本后降到 39 字节，同样的图片能少发一半二维码。
// 分隔符选 U+001F / U+001E / U+001D：都是不可见的控制字符，
// 正常的歌名/歌手/id 里不会出现，因此不需要任何转义。
// ────────────────────────────────────────────────────────────────────────────

/** 行内字段分隔（歌名 / 歌手 / id / platform） */
const FIELD_SEP = '\u001f';
/** 行分隔（元信息行 + 每首歌一行） */
const LINE_SEP = '\u001e';
/** 元信息字段分隔（版本 / 标题 / 作者 / 平台 / 描述） */
const META_SEP = '\u001d';

/**
 * 字段转义。
 *
 * 分隔符用的是控制字符，正常歌名/歌手里不该出现；但歌单数据来自第三方插件，
 * 不能假定干净——标题里真出现 U+001F 时会把字段切错，导致整条数据错位。
 * 因此把所有可能冲突的字符转义掉：`\` 先转义，再转义三个分隔符。
 * 正常数据不含这些字符，所以体积上几乎零开销。
 */
/** 反斜杠的码点，转义时需要优先处理 */
const BACKSLASH = 0x5c;

function escapeField(value: string): string {
    let needsEscape = false;
    for (let i = 0; i < value.length; ++i) {
        const code = value.charCodeAt(i);
        if (code === BACKSLASH || (code >= 0x1c && code <= 0x1f)) {
            needsEscape = true;
            break;
        }
    }
    if (!needsEscape) {
        return value;
    }

    let out = '';
    for (let i = 0; i < value.length; ++i) {
        const ch = value[i];
        switch (ch) {
            case '\\':
                out += '\\\\';
                break;
            case '\u001c':
                out += '\\c';
                break;
            case '\u001d':
                out += '\\d';
                break;
            case '\u001e':
                out += '\\e';
                break;
            case '\u001f':
                out += '\\f';
                break;
            default:
                out += ch;
        }
    }
    return out;
}

function unescapeField(value: string): string {
    if (!value.includes('\\')) {
        return value;
    }
    let out = '';
    for (let i = 0; i < value.length; ++i) {
        const ch = value[i];
        if (ch !== '\\' || i + 1 >= value.length) {
            out += ch;
            continue;
        }
        const next = value[++i];
        switch (next) {
            case 'c':
                out += '\u001c';
                break;
            case 'd':
                out += '\u001d';
                break;
            case 'e':
                out += '\u001e';
                break;
            case 'f':
                out += '\u001f';
                break;
            case '\\':
                out += '\\';
                break;
            default:
                // 未知转义按原样保留，避免把第三方数据吃掉
                out += next;
        }
    }
    return out;
}

/** 把歌单压成一段文本（字段已转义） */
function packSheet(sheet: SheetLike): string {
    const musicList = sheet.musicList ?? [];
    const songPlatform = sheet.platform;

    const head = [
        String(CODEC_VERSION),
        escapeField(sheet.title ?? ''),
        escapeField(sheet.artist ?? ''),
        escapeField(sheet.platform ?? ''),
        escapeField(sheet.description ?? ''),
    ].join(META_SEP);

    const lines = musicList.map((item) => {
        const fields = [
            escapeField(item?.title ?? ''),
            escapeField(item?.artist ?? ''),
            escapeField(item?.id ?? ''),
        ];
        // 只有和歌单 platform 不同的歌才需要额外存 platform
        if (item?.platform && item.platform !== songPlatform) {
            fields.push(escapeField(item.platform));
        }
        return fields.join(FIELD_SEP);
    });

    return [head, ...lines].join(LINE_SEP);
}

function unpackSheet(text: string): SheetLike {
    const lines = text.split(LINE_SEP);
    const head = (lines.shift() ?? '').split(META_SEP);
    const version = Number(head[0]);
    if (version !== CODEC_VERSION) {
        throw new Error('unsupported payload version');
    }

    const [, rawTitle, rawArtist, rawPlatform, rawDescription] = head;
    const title = unescapeField(rawTitle ?? '');
    const artist = unescapeField(rawArtist ?? '');
    const platform = unescapeField(rawPlatform ?? '');
    const description = unescapeField(rawDescription ?? '');

    const musicList: MusicItemLike[] = lines
        .filter((line) => line.length > 0)
        .map((line) => {
            const fields = line.split(FIELD_SEP);
            return {
                title: unescapeField(fields[0] ?? ''),
                artist: unescapeField(fields[1] ?? ''),
                id: unescapeField(fields[2] ?? ''),
                platform: fields[3] !== undefined ? unescapeField(fields[3]) : platform,
            };
        });

    return {
        title: title || undefined,
        artist: artist || undefined,
        platform: platform || undefined,
        description: description || undefined,
        musicList,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// 编码
// ────────────────────────────────────────────────────────────────────────────

export interface IEncodedFragment {
    index: number;
    total: number;
    /** 完整片段文本（可直接放进二维码 / 剪贴板 / 深链） */
    fragment: string;
    /** 片段 UTF-8 字节数 */
    byteLength: number;
}

export interface IEncodeSheetResult {
    fragments: IEncodedFragment[];
    /** 片段总数 */
    total: number;
    /** 压缩后的 payload 字节数 */
    payloadByteLength: number;
}

/**
 * 把歌单编码成一个或多个片段。
 *
 * @param sheet 歌单
 * @param byteLimit 单片段建议字节上限，默认 FRAGMENT_BYTE_LIMIT
 */
export function encodeSheet(
    sheet: SheetLike,
    byteLimit: number = FRAGMENT_BYTE_LIMIT,
): IEncodeSheetResult {
    // payload 就是 UTF-8 文本本身，不再经过 base64url
    const payloadText = packSheet(sheet);
    const checksum = crc32(payloadText);
    const payloadBytes = utf8Encode(payloadText);

    const limit = Math.max(64, byteLimit);

    // 头部形如 "MFS2:1/11:12345678:"，按最坏情况（total 为 3 位数）留出空间
    const headerBudget = FRAGMENT_PREFIX.length + 32;
    const bodyLimit = Math.max(32, limit - headerBudget);

    // 按「字节」切分，且必须在 UTF-8 字符边界上切，否则会出现半个汉字
    const bodies: string[] = [];
    if (payloadBytes.length === 0) {
        bodies.push('');
    } else {
        let start = 0;
        while (start < payloadBytes.length) {
            let end = Math.min(start + bodyLimit, payloadBytes.length);
            // 回退到合法字符边界（UTF-8 连续字节以 10xxxxxx 开头）
            while (
                end > start &&
                end < payloadBytes.length &&
                (payloadBytes[end] & 0xc0) === 0x80
            ) {
                end -= 1;
            }
            if (end === start) {
                // 单个字符就超过 bodyLimit，只能硬切（正常不会发生）
                end = Math.min(start + bodyLimit, payloadBytes.length);
            }
            bodies.push(utf8Decode(payloadBytes.subarray(start, end)));
            start = end;
        }
    }

    const total = bodies.length;
    const fragments = bodies.map((body, i) => {
        const bodyByteLength = utf8Encode(body).length;
        const fragment = buildFragment(i + 1, total, checksum, body, bodyByteLength);
        return {
            index: i + 1,
            total,
            byteLength: utf8Encode(fragment).length,
            fragment,
        };
    });

    return {
        fragments,
        total,
        payloadByteLength: payloadBytes.length,
    };
}

/**
 * 生成歌单分享深链。
 * 单片段时直接内嵌数据；多片段时只带总数，完整数据仍由二维码承载。
 */
export function buildSheetDeeplink(encoded: IEncodeSheetResult): string {
    if (encoded.total === 1) {
        return `${SHEET_DEEPLINK_PREFIX}?d=${encoded.fragments[0].fragment}`;
    }
    return `${SHEET_DEEPLINK_PREFIX}?n=${encoded.total}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 解码
// ────────────────────────────────────────────────────────────────────────────

/**
 * 从一段自由文本中提取所有片段。
 *
 * 正文用头部声明的「UTF-8 字节数」来切，因此片段里出现换行、冒号、
 * 数字、控制字符都不会影响解析。
 */
export function extractFragments(text: string): string[] {
    if (!text) {
        return [];
    }
    const result: string[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf(FRAGMENT_PREFIX, cursor);
        if (start === -1) {
            break;
        }

        const afterPrefix = start + FRAGMENT_PREFIX.length;

        // 1) index/total
        const seqEnd = findDelimiter(text, afterPrefix);
        if (seqEnd === -1) {
            cursor = afterPrefix;
            continue;
        }
        const seqMatch = /^(\d+)\/(\d+)$/.exec(text.slice(afterPrefix, seqEnd));
        if (!seqMatch) {
            cursor = seqEnd + 1;
            continue;
        }
        const index = Number(seqMatch[1]);
        const total = Number(seqMatch[2]);
        if (total < 1 || total > MAX_FRAGMENT_COUNT || index < 1 || index > total) {
            cursor = seqEnd + 1;
            continue;
        }

        // 2) checksum（定宽十六进制）
        const checksumStart = seqEnd + 1;
        const checksum = text.slice(checksumStart, checksumStart + CHECKSUM_DIGITS);
        if (!/^[0-9a-f]{8}$/.test(checksum)) {
            cursor = checksumStart;
            continue;
        }
        if (text[checksumStart + CHECKSUM_DIGITS] !== ':') {
            cursor = checksumStart;
            continue;
        }

        // 3) bodyByteLength（定宽 base36）
        const lenStart = checksumStart + CHECKSUM_DIGITS + 1;
        const lenText = text.slice(lenStart, lenStart + BODY_LENGTH_DIGITS);
        if (!/^[0-9a-z]{4}$/.test(lenText)) {
            cursor = lenStart;
            continue;
        }
        if (text[lenStart + BODY_LENGTH_DIGITS] !== ':') {
            cursor = lenStart;
            continue;
        }
        const bodyByteLength = parseInt(lenText, 36);
        if (!Number.isFinite(bodyByteLength) || bodyByteLength < 0) {
            cursor = lenStart;
            continue;
        }

        // 4) 正文：按声明的字节数累加，保证落在字符边界上。
        //    注意必须按「码点」而不是码元累加：text[pos] 取到的是单个 UTF-16 码元，
        //    emoji 这类代理对被拆开后 TextEncoder 会替换成 U+FFFD（3 字节），
        //    而完整码点是 4 字节，会导致少算 2 字节并切掉正文尾部。
        const bodyStart = lenStart + BODY_LENGTH_DIGITS + 1;
        let used = 0;
        let pos = bodyStart;
        while (pos < text.length && used < bodyByteLength) {
            const code = text.charCodeAt(pos);
            const isSurrogatePair = code >= 0xd800 && code <= 0xdbff && pos + 1 < text.length;
            used += utf8Encode(isSurrogatePair ? text.slice(pos, pos + 2) : text[pos]).length;
            pos += isSurrogatePair ? 2 : 1;
        }

        if (used === bodyByteLength) {
            result.push(text.slice(start, pos));
            cursor = pos;
        } else {
            // 正文缺失（信息被截断），跳过这个头部继续找
            cursor = bodyStart;
        }
    }

    return result;
}

/** 从 from 开始找第一个分隔符 ':'，最多向后看 8 个字符（index/total 不会更长） */
function findDelimiter(text: string, from: number): number {
    const limit = Math.min(text.length, from + 8);
    for (let i = from; i < limit; ++i) {
        if (text[i] === ':') {
            return i;
        }
    }
    return -1;
}

/** 解析单个片段的头部（含正文），不校验 CRC */
export function parseFragmentHeader(
    fragment: string,
): { index: number; total: number; checksum: string; body: string } | null {
    const trimmed = fragment.trim();
    if (!trimmed.startsWith(FRAGMENT_PREFIX)) {
        return null;
    }
    const rest = trimmed.slice(FRAGMENT_PREFIX.length);

    const seqMatch = /^(\d+)\/(\d+):/.exec(rest);
    if (!seqMatch) {
        return null;
    }
    const index = Number(seqMatch[1]);
    const total = Number(seqMatch[2]);
    if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 1) {
        return null;
    }
    if (index > total || total > MAX_FRAGMENT_COUNT) {
        return null;
    }

    const afterSeq = rest.slice(seqMatch[0].length);
    const checksum = afterSeq.slice(0, CHECKSUM_DIGITS);
    if (!/^[0-9a-f]{8}$/.test(checksum) || afterSeq[CHECKSUM_DIGITS] !== ':') {
        return null;
    }

    const afterChecksum = afterSeq.slice(CHECKSUM_DIGITS + 1);
    const lenText = afterChecksum.slice(0, BODY_LENGTH_DIGITS);
    if (!/^[0-9a-z]{4}$/.test(lenText) || afterChecksum[BODY_LENGTH_DIGITS] !== ':') {
        return null;
    }
    const bodyByteLength = parseInt(lenText, 36);
    if (!Number.isFinite(bodyByteLength) || bodyByteLength < 0) {
        return null;
    }

    const body = afterChecksum.slice(BODY_LENGTH_DIGITS + 1);
    // 正文长度必须与声明一致，否则说明片段被截断/污染。
    // 注意：这里的比较是精确的——encode 侧同样按码点计算 UTF-8 字节数。
    if (utf8Encode(body).length !== bodyByteLength) {
        return null;
    }

    return { index, total, checksum, body };
}

interface IFragmentGroup {
    total: number;
    bodies: Map<number, string>;
}

/**
 * 歌单分片收集器。
 *
 * 同一份歌单的多个二维码可以乱序、重复被扫到，收集器负责去重与拼装。
 *
 * 片段按「CRC 校验和」分组：一张图里完全可能出现两份不同歌单的二维码
 * （聊天记录里带了两张分享图、或用户拼图）。若遇到 total 不一致就静默丢弃，
 * 会导致进度永久卡住且没有任何提示；分组后两份歌单各收各的，谁先收齐谁先出结果。
 */
export class SheetFragmentCollector {
    /** 按 CRC 校验和分组存放片段，同一张图里的多份歌单互不干扰 */
    private groups = new Map<string, IFragmentGroup>();

    /** 当前选中的组 */
    private selectedChecksum: string | null = null;

    private bodies = new Map<number, string>();

    private total = 0;

    private checksum = '';

    /** 目前已经收齐的片数（选中的那一组） */
    public get received(): number {
        return this.bodies.size;
    }

    /** 片段总数（未收到任何片段时为 0） */
    public get totalCount(): number {
        return this.total;
    }

    /** 是否已收齐 */
    public get isComplete(): boolean {
        return this.total > 0 && this.bodies.size === this.total;
    }

    /** 清空已收集的片段 */
    public reset(): void {
        this.groups.clear();
        this.selectedChecksum = null;
        this.bodies.clear();
        this.total = 0;
        this.checksum = '';
    }

    /** 还缺哪些段（从 1 开始计数） */
    public missingIndexes(): number[] {
        const missing: number[] = [];
        if (this.total <= 0) {
            return missing;
        }
        for (let i = 1; i <= this.total; ++i) {
            if (!this.bodies.has(i)) {
                missing.push(i);
            }
        }
        return missing;
    }

    /**
     * 投递一个片段。
     *
     * - 收齐并校验通过 -> { status: "ok" }
     * - 还没收齐 -> { status: "incomplete" }
     * - 片段非法 / 校验失败 -> { status: "error" }
     */
    public push(fragment: string): DecodeFragmentResult {
        const header = parseFragmentHeader(fragment);
        if (!header) {
            return { status: 'error', code: 'NOT_A_FRAGMENT' };
        }

        let group = this.groups.get(header.checksum);
        if (!group) {
            group = { total: header.total, bodies: new Map() };
            this.groups.set(header.checksum, group);
        }
        group.bodies.set(header.index, header.body);
        // 同一组内以最大的 total 为准，避免被误读成更小 total 的片段带偏
        group.total = Math.max(group.total, header.total);

        if (!this.selectedChecksum) {
            this.selectedChecksum = header.checksum;
        } else if (!isGroupComplete(this.groups.get(this.selectedChecksum)!)) {
            // 当前组还没齐时，重新挑一次「能成功还原且进度最高」的组
            this.selectedChecksum = pickBestGroup(this.groups);
        }

        this.applySelected();

        if (!this.isComplete) {
            return {
                status: 'incomplete',
                index: header.index,
                total: this.total,
                received: this.received,
            };
        }

        return this.assemble();
    }

    /** 立刻尝试拼装（用于判断是否已可解码） */
    public assemble(): DecodeFragmentResult {
        this.selectedChecksum = pickBestGroup(this.groups);
        this.applySelected();

        if (!this.selectedChecksum) {
            return { status: 'incomplete', index: 0, total: 0, received: 0 };
        }

        const group = this.groups.get(this.selectedChecksum)!;
        if (!isGroupComplete(group)) {
            return {
                status: 'incomplete',
                index: 0,
                total: this.total,
                received: this.received,
            };
        }

        return assembleGroup(this.selectedChecksum, group);
    }

    /** 把选中组的信息同步到公开字段上 */
    private applySelected(): void {
        const group = this.selectedChecksum ? this.groups.get(this.selectedChecksum) : undefined;
        if (!group || !this.selectedChecksum) {
            this.selectedChecksum = null;
            this.bodies = new Map();
            this.total = 0;
            this.checksum = '';
            return;
        }
        this.bodies = group.bodies;
        this.total = group.total;
        this.checksum = this.selectedChecksum;
    }
}

/** 某个组是否已收齐 */
function isGroupComplete(group: IFragmentGroup): boolean {
    return group.total > 0 && group.bodies.size >= group.total;
}

/**
 * 从所有分组里挑出要展示的那一组。
 *
 * 不能只看「片数是否够」：一个被识别错误污染的片段会带着错误的 checksum
 * 自成一组，且可能刚好凑成 total=1 的"完整"组，如果只按完整度挑组，
 * 它会把真正可用的一组挡在后面。所以以「能否成功拼装」作为最终判据。
 */
function pickBestGroup(groups: Map<string, IFragmentGroup>): string | null {
    let fallback: string | null = null;
    let fallbackProgress = -1;

    for (const [checksum, group] of groups) {
        if (!isGroupComplete(group)) {
            if (group.bodies.size > fallbackProgress) {
                fallbackProgress = group.bodies.size;
                fallback = checksum;
            }
            continue;
        }
        if (assembleGroup(checksum, group).status === 'ok') {
            return checksum;
        }
        if (fallback === null) {
            fallback = checksum;
        }
    }

    return fallback;
}

/** 对指定分组执行拼装 */
function assembleGroup(checksum: string, group: IFragmentGroup): DecodeFragmentResult {
    const { total, bodies } = group;

    // 片数与头部声明不符：说明片段正文被识别错误污染了，
    // 这种情况下宁可报错也不能拼出一份看起来正常、实际残缺的歌单
    if (bodies.size !== total) {
        return { status: 'error', code: 'MALFORMED' };
    }

    let body = '';
    for (let i = 1; i <= total; ++i) {
        body += bodies.get(i) ?? '';
    }

    // v2 的 body 直接就是 UTF-8 文本，不需要 base64 解码
    if (checksum && crc32(body) !== checksum) {
        return { status: 'error', code: 'CHECKSUM_MISMATCH' };
    }

    let payload: SheetLike;
    try {
        payload = unpackSheet(body);
    } catch {
        return { status: 'error', code: 'MALFORMED' };
    }

    return {
        status: 'ok',
        index: 0,
        total,
        payload,
        received: bodies.size,
    };
}

/** 便捷方法：一次性解码单个自包含片段 */
export function decodeSheetFragment(fragment: string): DecodeFragmentResult {
    const collector = new SheetFragmentCollector();
    return collector.push(fragment);
}

/** 便捷方法：从自由文本（可能包含多个片段/深链）中解码 */
export function decodeSheetFromText(text: string): DecodeFragmentResult {
    const fragments = extractFragments(text);
    if (fragments.length === 0) {
        return { status: 'error', code: 'NOT_A_FRAGMENT' };
    }
    const collector = new SheetFragmentCollector();
    let last: DecodeFragmentResult = { status: 'error', code: 'NOT_A_FRAGMENT' };
    let weakestError: DecodeFragmentResult | null = null;
    let accepted = 0;

    for (const fragment of fragments) {
        const result = collector.push(fragment);
        if (result.status === 'ok') {
            return result;
        }
        if (result.status === 'error') {
            // 抄错/损坏的片段不该带走同一段文本里其它可用的片段，
            // 记下来继续试，全部片段都试完仍没成功才把错误报出去
            weakestError = weakestError ?? result;
            continue;
        }
        accepted += 1;
        last = result;
    }

    if (accepted > 0 && last.status === 'incomplete') {
        // 至少有一个片段被收集：如实报告缺口，而不是报「不是片段」。
        // 正文里若恰好出现 "MFS2:" 字面量，会被 extractFragments 误当成一个假头部，
        // 若不这样处理，一个假头部就能让整份文本导入失败。
        return last;
    }
    return weakestError ?? last;
}
