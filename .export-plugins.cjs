/* eslint-disable */
/**
 * 一次性工具：把本机已安装的 MusicFree 插件打成一份自包含的 JSON。
 *
 * 数据来源：
 *   %APPDATA%\MusicFree\musicfree-plugins\*.js   插件源码
 *   %APPDATA%\MusicFree\.plugin-cache.json       插件元数据（platform/author/version/srcUrl/hash…）
 *   %APPDATA%\MusicFree\.plugin-meta.json        用户侧 meta（排序 order / enabled / userVariables）
 *
 * 输出格式与桌面端「插件管理 → 安装插件 → 选择文件(.json)」兼容：
 * 顶层 plugins[] 里带 url 的条目会被逐条安装。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(process.env.APPDATA, 'MusicFree');
const PLUGIN_DIR = path.join(APP_DIR, 'musicfree-plugins');
const OUT = process.argv[2];

const readJson = (p, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return fallback;
    }
};

const cache = readJson(path.join(APP_DIR, '.plugin-cache.json'), { plugins: [] });
const meta = readJson(path.join(APP_DIR, '.plugin-meta.json'), {}) || {};
const appPkg = readJson(path.join(__dirname, 'package.json'), {});

const cacheByHash = new Map();
for (const p of cache.plugins || []) {
    if (p.hash) cacheByHash.set(p.hash, p);
}

const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.js'));
const plugins = [];

for (const fileName of files) {
    const full = path.join(PLUGIN_DIR, fileName);
    const code = fs.readFileSync(full, 'utf-8');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const info = cacheByHash.get(hash) || {};
    const m = meta[hash] || {};

    const entry = { platform: info.platform ?? path.basename(fileName, '.js') };
    if (info.srcUrl) entry.url = info.srcUrl;
    if (info.author) entry.author = info.author;
    if (info.version) entry.version = info.version;
    if (info.appVersion) entry.appVersion = info.appVersion;
    entry.hash = hash;
    if (typeof m.order === 'number') entry.order = m.order;
    if (typeof m.enabled === 'boolean') entry.enabled = m.enabled;
    if (m.userVariables && Object.keys(m.userVariables).length) {
        entry.userVariables = m.userVariables;
    }
    if (info._path && path.basename(info._path) !== fileName) {
        entry.originalFileName = path.basename(info._path);
    }
    entry.fileName = fileName;
    entry.size = Buffer.byteLength(code, 'utf-8');
    if (Array.isArray(info.supportedMethod)) entry.supportedMethod = info.supportedMethod;
    entry.code = code;
    plugins.push(entry);
}

// 按用户在插件页里排好的顺序输出
plugins.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a.platform).localeCompare(String(b.platform), 'zh');
});

const bundle = {
    format: 'musicfree-plugin-bundle',
    version: 1,
    generator: `${appPkg.productName ?? 'MusicFree'} ${appPkg.version ?? ''}`.trim(),
    exportedAt: new Date().toISOString(),
    source: { appData: APP_DIR, pluginDir: PLUGIN_DIR },
    count: plugins.length,
    plugins,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(bundle, null, 2), 'utf-8');

const withUrl = plugins.filter((p) => p.url).length;
const withVars = plugins.filter((p) => p.userVariables).length;
const withDisabled = plugins.filter((p) => p.enabled === false).length;
console.log(
    JSON.stringify(
        {
            out: OUT,
            bytes: fs.statSync(OUT).size,
            count: plugins.length,
            withUrl,
            withoutUrl: plugins.filter((p) => !p.url).map((p) => p.platform),
            withUserVariables: withVars,
            disabled: withDisabled,
            order: plugins.map((p) => `${p.order ?? '-'}:${p.platform}`).join(' > '),
        },
        null,
        2,
    ),
);
