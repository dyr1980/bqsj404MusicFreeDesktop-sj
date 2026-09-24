/**
 * Zotero-only WebDAV 兼容层（主进程专用）
 *
 * 背景：**中国科技云数据胶囊**（`https://data.cstcloud.cn/dav`）的 WebDAV 网关只放行
 * Zotero 客户端。实测（PROPFIND/OPTIONS/PUT 逐条验证）它卡两件事：
 *
 *   1. `User-Agent` 不像 Zotero → 一律 `403 Client type mismatch.`
 *      （带 `Zotero/8.0` 的 UA → 200/201）
 *   2. **上传（PUT）的文件名不以 `.zip` 结尾** → 同样 `403 Client type mismatch.`
 *      （`.txt` 被拒；`foo.zip`、`foo_hash.txt.zip`、`foo_hash.flac.zip` 都放行）
 *
 * 读（GET/PROPFIND）、建目录（MKCOL）、MOVE 都不校验名字，只有上传卡 `.zip`。
 * 所以这里做两件事，且**只对匹配的主机生效**（其它 WebDAV 服务行为完全不变）：
 *
 *   - 给该主机的所有 WebDAV 请求（含本地转发器取流）带 Zotero UA
 *   - 上传时把文件名映射成 `<名字>_<HMAC>.<原后缀>.zip`（列表展示时再还原）
 *
 * HMAC 用固定 key 对「原始文件名」做 HMAC-SHA256 取前 32 位十六进制：
 * **纯函数、与内容无关**，所以「写」和「读」能各自算出同一个名字，不需要额外索引；
 * 服务端并不校验哈希的值（实测随便填十六进制都放行），它只是用来凑出 Zotero 那个形状。
 *
 * ⚠️ 改算法/HMAC key 会让已上传的文件「换名」，历史文件将读不到 —— 要改就得同时兼容旧名。
 */
import { createHmac } from 'crypto';

/** 需要兼容的主机（只认主机名，不看路径） */
const ZOTERO_ONLY_HOSTS = new Set(['data.cstcloud.cn']);

/**
 * 伪装成 Zotero 的 User-Agent。
 * Zotero 的 WebDAV 请求本身用的是它所基于的 Firefox 的 UA，实测这个串能过网关。
 */
export const ZOTERO_DAV_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0 Zotero/8.0';

/** HMAC key（固定常量，改动会导致历史文件名变化） */
const HMAC_KEY = 'MusicFree/dav-compat/v1';

/** 映射后的文件名形态：<名字>_<32位hex>.<原后缀>.zip */
const MAPPED_NAME_RE = /_([0-9a-f]{32})\.([^./\\]*)\.zip$/i;

/** 这个 WebDAV 地址是否需要 Zotero 兼容 */
export function isZoteroOnlyDav(url: string | undefined | null): boolean {
    if (!url) return false;
    try {
        return ZOTERO_ONLY_HOSTS.has(new URL(url).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** 需要附加的请求头（不需要兼容时返回 undefined，避免影响其它服务） */
export function davExtraHeaders(
    url: string | undefined | null,
): Record<string, string> | undefined {
    return isZoteroOnlyDav(url) ? { 'User-Agent': ZOTERO_DAV_UA } : undefined;
}

/** 文件名 → HMAC（32 位十六进制） */
function hashOf(fileName: string): string {
    return createHmac('sha256', HMAC_KEY).update(fileName).digest('hex').slice(0, 32);
}

/**
 * 逻辑文件名 → 远端存储名。
 *
 * `王菲 - 如愿.flac` → `王菲 - 如愿_8f14e45f….flac.zip`
 *
 * 已经是映射形态的名字原样返回（幂等），避免「列表拿到的存储名又被映射一次」。
 */
export function toStoredName(fileName: string): string {
    if (!fileName || MAPPED_NAME_RE.test(fileName)) return fileName;
    const dot = fileName.lastIndexOf('.');
    // 没有扩展名也要以 .zip 结尾，否则网关直接 403
    if (dot <= 0) return `${fileName}_${hashOf(fileName)}.zip`;
    const base = fileName.slice(0, dot);
    const ext = fileName.slice(dot + 1);
    return `${base}_${hashOf(fileName)}.${ext}.zip`;
}

/** 远端存储名 → 逻辑文件名（不是我们映射出来的名字则原样返回，例如真 Zotero 的 key.zip） */
export function toLogicalName(storedName: string): string {
    const m = MAPPED_NAME_RE.exec(storedName ?? '');
    if (!m) return storedName;
    const base = storedName.slice(0, m.index);
    return m[2] ? `${base}.${m[2]}` : base;
}

/** 远端路径 → 映射后的远端路径（只换最后一段文件名，目录不动） */
export function toStoredPath(remotePath: string): string {
    if (!remotePath) return remotePath;
    const idx = Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\'));
    if (idx < 0) return toStoredName(remotePath);
    return `${remotePath.slice(0, idx + 1)}${toStoredName(remotePath.slice(idx + 1))}`;
}

/** 远端路径 → 逻辑路径（只换最后一段文件名） */
export function toLogicalPath(remotePath: string): string {
    if (!remotePath) return remotePath;
    const idx = Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\'));
    if (idx < 0) return toLogicalName(remotePath);
    return `${remotePath.slice(0, idx + 1)}${toLogicalName(remotePath.slice(idx + 1))}`;
}
