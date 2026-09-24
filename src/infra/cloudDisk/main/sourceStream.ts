/**
 * sourceStream — 把「插件音源」打开成一条可直接上传的流
 *
 * 「不下载到本地也能传云端」靠它：用 Electron 的 net（Chromium 网络栈，和下载/在线播放
 * 同一套，因此也吃应用里的代理设置）发起 GET，返回响应流；并**先读前 16 字节嗅探真实
 * 容器**再 unshift 回去 —— 远端文件名是 `歌名 - 歌手.ext`，扩展名错了云盘列表会直接
 * 看不见这个文件（列表按 `SUPPORTED_AUDIO_EXTS` 过滤）。
 *
 * 与 `downloadManager` 的关系：那边是「取流 → 落盘」，这里是「取流 → 直接 PUT 到 WebDAV」，
 * 网络栈、鉴权头、音质回退都复用同一套（取源在主进程做，见 cloudDisk.uploadFromSource）。
 */

import { net, session } from 'electron';
import type { ClientRequest, IncomingMessage } from 'electron';
import type { Readable } from 'stream';
import { pickAudioExt, sniffExtFromBuffer } from '@common/audioContainer';

/** 嗅探容器需要的头部字节数 */
const HEAD_BYTES = 16;

export interface IOpenedSourceStream {
    /** 响应流（嗅探用的头部字节已经 unshift 回去，可直接给 PUT 用） */
    stream: Readable;
    /** 远端要用的扩展名（含点号，保证落在支持列表里） */
    ext: string;
    /** 音源字节数（服务端没给 Content-Length 时为 0） */
    size: number;
}

/**
 * 打开插件音源。
 *
 * @param url     插件返回的音源地址
 * @param headers 取源结果里带的请求头（Referer / UA / Cookie 等，部分源缺了会 403）
 * @throws 音源不可达或返回 4xx/5xx 时抛错（调用方按「这一条上传失败」处理）
 */
export async function openSourceStream(
    url: string,
    headers: Record<string, string> = {},
): Promise<IOpenedSourceStream> {
    if (!url) throw new Error('音源地址为空');

    // 诊断：到底从哪出去（DIRECT / PROXY ...），和下载那边同一行日志口径
    void session.defaultSession
        .resolveProxy(url)
        .then((resolved) => {
            console.log('[cloud-upload] resolveProxy:', resolved, '|', url.slice(0, 70));
        })
        .catch((): void => undefined);

    const response = await requestViaElectronNet(url, headers);
    const status = response.statusCode ?? 0;
    if (status >= 400) {
        destroyStream(response);
        throw new Error(`音源响应 ${status}`);
    }

    const size = Number(response.headers['content-length'] ?? 0) || 0;
    const head = await peekHead(response as unknown as Readable, HEAD_BYTES);
    if (!head) {
        destroyStream(response);
        throw new Error('音源没有数据（读不到文件头）');
    }
    const ext = pickAudioExt({
        sniffed: sniffExtFromBuffer(head),
        contentType: String(response.headers['content-type'] ?? ''),
        url,
    });

    return { stream: response as unknown as Readable, ext, size };
}

/** 用 Electron 的 net 发 GET（Chromium 网络栈，与在线播放/下载一致） */
function requestViaElectronNet(
    url: string,
    headers: Record<string, string>,
): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
        const request: ClientRequest = net.request({ url, useSessionCookies: true });
        let settled = false;

        for (const [key, value] of Object.entries(headers)) {
            try {
                request.setHeader(key, value);
            } catch {
                /* 个别 header 不被允许时忽略 */
            }
        }

        request.on('response', (response) => {
            settled = true;
            console.log('[cloud-upload] net response:', response.statusCode, '|', url.slice(0, 70));
            resolve(response);
        });

        request.on('error', (err) => {
            if (settled) return;
            settled = true;
            console.log(
                '[cloud-upload] net error:',
                err?.message ?? String(err),
                '|',
                url.slice(0, 70),
            );
            reject(err);
        });

        request.end();
    });
}

/**
 * 偷看流开头的 min 个字节（**看完塞回去**，流内容不变）。拿不到返回 null。
 *
 * 注意「流已经结束」的情况不能再 unshift（Node 会抛 ERR_STREAM_UNSHIFT_AFTER_END_EVENT），
 * 这种响应本身就是坏的（空响应 / 一小段 HTML 错误页），直接当失败处理更实在。
 */
function peekHead(stream: Readable, min: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;

        const cleanup = () => {
            stream.removeListener('readable', onReadable);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        };

        const finish = (head: Buffer | null) => {
            cleanup();
            if (head?.length) stream.unshift(head);
            resolve(head);
        };

        const onReadable = () => {
            let chunk: Buffer | null;
            while (total < min && (chunk = stream.read(min - total) as Buffer | null)) {
                chunks.push(chunk);
                total += chunk.length;
            }
            if (total >= min) finish(Buffer.concat(chunks));
        };

        // 还没读满就结束了 → 数据已经消费掉、放不回去，只能是坏响应
        const onEnd = () => finish(null);
        const onError = () => finish(null);

        stream.on('readable', onReadable);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

function destroyStream(stream: unknown): void {
    const destroy = (stream as { destroy?: () => void })?.destroy;
    if (typeof destroy === 'function') destroy.call(stream);
}
