/**
 * downloadManager — 下载任务执行器
 *
 * 职责：
 * - 单个文件的 HTTP 流式下载（支持断点续传）
 * - 从 Content-Type 推断文件扩展名
 * - 下载速度计算
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { net, session } from 'electron';
import type { ClientRequest, IncomingMessage } from 'electron';
import { safeParse } from '@common/safeSerialize';
import { MIME_TO_EXT, sniffExtFromBuffer } from '@common/audioContainer';
import type { IDownloadTask } from '@appTypes/infra/downloadManager';

/**
 * 读文件头判断真实音频容器，返回对应扩展名（判断不出来返回 null）。
 *
 * Content-Type 与实际字节不一致时（CDN 常见），扩展名必须以内容为准：
 * 扩展名错了会让元数据解析器选错分支，时长/标签全废。
 */
export async function sniffContainerExt(filePath: string): Promise<string | null> {
    try {
        const handle = await fsp.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(16);
            const { bytesRead } = await handle.read(buffer, 0, 16, 0);
            if (bytesRead < 12) return null;
            return sniffExtFromBuffer(buffer);
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

export class DownloadTask {
    public task: IDownloadTask;
    public speed = 0;
    public isAborted = false;
    private abortController: AbortController | null = null;
    private writeStream: fs.WriteStream | null = null;

    /** 当前 net 请求的中止函数（Electron net 不用 AbortController） */
    private abortNetRequest: (() => void) | null = null;
    private lastSpeedCheckTime = 0;
    private lastSpeedCheckBytes = 0;

    constructor(task: IDownloadTask) {
        this.task = task;
    }

    /**
     * 执行下载。
     * 支持断点续传：如果 tempPath 已存在，读取已有大小作为 Range 起点。
     */
    async execute(
        onProgress: (downloadedBytes: number, totalBytes: number, speed: number) => void,
        onCompleted: () => void,
        onError: (err: Error) => void,
    ): Promise<void> {
        try {
            const mediaSource = safeParse<Record<string, any>>(this.task.mediaSource ?? '');
            if (!mediaSource) throw new Error('Invalid mediaSource');
            const url = mediaSource.url;
            if (!url) throw new Error('No download URL');

            // 1. 检查已有临时文件（断点续传）
            // 始终以临时文件的实际大小为准，忽略 DB 中的 downloadedBytes
            let existingBytes = 0;
            if (this.task.tempPath) {
                try {
                    const stat = await fsp.stat(this.task.tempPath);
                    existingBytes = stat.size;
                } catch {
                    existingBytes = 0;
                }
            }

            // 2. 构建请求 headers
            const headers: Record<string, string> = {
                ...(mediaSource.headers ?? {}),
            };
            if (mediaSource.userAgent) {
                headers['User-Agent'] = mediaSource.userAgent;
            }
            if (existingBytes > 0) {
                headers['Range'] = `bytes=${existingBytes}-`;
            }

            // 3. 发起请求
            //
            // 走 Electron 的 net（Chromium 网络栈），而不是 axios（Node 的 https）：
            // 部分音源 CDN 放行 Chromium 的 TLS 握手、直接断开 Node 的握手，
            // 表现就是「能在线播放、但下载全部失败」：
            //   Client network socket disconnected before secure TLS connection was established
            const response = await this.requestViaElectronNet(url, headers);

            // 4. 解析总大小
            const contentLength = parseInt(String(response.headers['content-length'] ?? '0'), 10);
            const isPartial = response.statusCode === 206;

            if (isPartial) {
                this.task.totalBytes = existingBytes + contentLength;
                this.task.downloadedBytes = existingBytes;
            } else {
                // 服务器不支持 Range，从头下载；-1 表示总大小未知
                this.task.totalBytes = contentLength > 0 ? contentLength : -1;
                this.task.downloadedBytes = 0;
                existingBytes = 0;
            }

            // 5. 创建写入流
            await fsp.mkdir(path.dirname(this.task.tempPath!), { recursive: true });
            this.writeStream = fs.createWriteStream(this.task.tempPath!, {
                flags: isPartial ? 'a' : 'w',
            });

            // 6. 流式下载
            this.lastSpeedCheckTime = Date.now();
            this.lastSpeedCheckBytes = this.task.downloadedBytes;

            // Electron 的 IncomingMessage 运行时就是 Node Readable，类型声明没暴露，这里补一下
            const dataStream = response as unknown as NodeJS.ReadableStream;
            dataStream.on('data', (chunk: Buffer) => {
                this.task.downloadedBytes += chunk.length;

                const now = Date.now();
                const elapsed = (now - this.lastSpeedCheckTime) / 1000;
                if (elapsed >= 1) {
                    this.speed = (this.task.downloadedBytes - this.lastSpeedCheckBytes) / elapsed;
                    this.lastSpeedCheckTime = now;
                    this.lastSpeedCheckBytes = this.task.downloadedBytes;
                }

                onProgress(this.task.downloadedBytes, this.task.totalBytes, this.speed);
            });

            dataStream.pipe(this.writeStream);

            await new Promise<void>((resolve, reject) => {
                this.writeStream!.on('finish', resolve);
                this.writeStream!.on('error', reject);
                dataStream.on('error', reject);
            });

            // 7. 推断文件扩展名：优先看文件真实内容，再看 Content-Type，最后兜底 .mp3
            //
            // 必须看内容：CDN 的 Content-Type 经常和实际字节对不上
            // （实测酷我某源回的是 M4A/AAC，头里却按 mp3 处理），扩展名错了会让
            // music-metadata 用错解析器 —— 时长会解析成 0.01 秒之类，
            // 然后被「过滤短音频」挡掉，表现就是「下载完成了但本地音乐里看不到」。
            const sniffedExt = await sniffContainerExt(this.task.tempPath!);
            const contentType = String(response.headers['content-type'] ?? '');
            const finalPath = await this.resolveFinalPath(contentType, sniffedExt ?? undefined);

            // 8. 下载完成 → rename 临时文件
            await fsp.rename(this.task.tempPath!, finalPath);
            this.task.filePath = finalPath;

            onCompleted();
        } catch (err: any) {
            if (axios.isCancel(err) || (err as { aborted?: boolean })?.aborted) return;
            onError(err);
        } finally {
            // 确保 writeStream 被清理
            if (this.writeStream) {
                this.writeStream.destroy();
                this.writeStream = null;
            }
        }
    }

    /** 中止下载（暂停或取消时调用） */
    abort(): void {
        this.isAborted = true;
        this.abortController?.abort();
        this.abortController = null;
        this.writeStream?.destroy();
        this.writeStream = null;
    }

    /**
     * 从 Content-Type 推断文件扩展名，兜底 .mp3。
     * filePath 不含扩展名（由 buildFileName 生成），此处追加推断的扩展名。
     * 若目标路径已存在文件，自动追加数字后缀避免覆盖。
     */
    /**
     * 用 Electron 的 net 模块发请求（Chromium 网络栈，与在线播放一致）。
     *
     * 为什么不用 axios：axios 走 Node 的 https，部分音源 CDN 会断开它的 TLS 握手，
     * 而同一 URL 用 Chromium 栈就能正常下载。
     *
     * @returns net 的 IncomingMessage（本身是 Readable，可直接 pipe）
     */
    private requestViaElectronNet(
        url: string,
        headers: Record<string, string>,
    ): Promise<IncomingMessage> {
        return new Promise<IncomingMessage>((resolve, reject) => {
            // 诊断：Electron 栈到底从哪出去（DIRECT / PROXY ...）。
            // 下载失败时这一行能立刻区分「走了代理」还是「栈本身有问题」。
            void session.defaultSession
                .resolveProxy(url)
                .then((resolved) => {
                    console.log('[download] resolveProxy:', resolved, '|', url.slice(0, 70));
                })
                .catch((): void => undefined);

            const request: ClientRequest = net.request({ url, useSessionCookies: true });
            let settled = false;

            for (const [key, value] of Object.entries(headers)) {
                try {
                    request.setHeader(key, value);
                } catch {
                    /* 个别 header 不被允许时忽略 */
                }
            }

            this.abortNetRequest = () => {
                if (!settled) {
                    settled = true;
                    request.abort();
                    reject(Object.assign(new Error('download aborted'), { aborted: true }));
                }
            };

            request.on('response', (response) => {
                settled = true;
                console.log('[download] net response:', response.statusCode, '|', url.slice(0, 70));
                this.abortNetRequest = () =>
                    (response as unknown as { destroy: () => void }).destroy();
                resolve(response);
            });

            request.on('error', (err) => {
                if (settled) return;
                settled = true;
                console.log(
                    '[download] net error:',
                    err?.message ?? String(err),
                    '|',
                    url.slice(0, 70),
                );
                reject(err);
            });

            request.end();
        });
    }

    private async resolveFinalPath(contentType: string, sniffedExt?: string): Promise<string> {
        const mime = contentType.split(';')[0].trim().toLowerCase();
        // 嗅探出来的扩展名优先：头可以撒谎，文件头不会
        const ext = sniffedExt ?? MIME_TO_EXT[mime] ?? '.mp3';
        const base = this.task.filePath!;
        let candidate = base + ext;

        // 避免覆盖已有文件
        let suffix = 1;
        while (true) {
            try {
                await fsp.access(candidate);
                // 文件存在，尝试下一个后缀
                candidate = `${base} (${suffix})${ext}`;
                suffix++;
            } catch (err: any) {
                if (err?.code === 'ENOENT') break;
                throw err; // 权限不足等 I/O 错误向上抛出
            }
        }

        return candidate;
    }
}
