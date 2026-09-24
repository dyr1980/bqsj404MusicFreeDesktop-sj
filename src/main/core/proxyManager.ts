/**
 * ProxyManager — 代理管理器
 *
 * 监听 appConfig 中 network.proxy.* 变更，
 * 将代理配置统一分发到所有网络出口：
 *   1. Electron Session（渲染进程请求）
 *   2. 全局 axios defaults（downloadManager / pluginManager / 插件沙箱）
 *   3. RequestForwarder Worker（音频流转发）
 */

import { app, session } from 'electron';
import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { IAppConfigReader, IAppConfig } from '@appTypes/infra/appConfig';

const PROXY_CONFIG_KEYS: Array<keyof IAppConfig> = [
    'network.proxy.enabled',
    'network.proxy.host',
    'network.proxy.port',
    'network.proxy.username',
    'network.proxy.password',
];

interface IProxyConfig {
    proxyUrl: string;
    host: string;
    port: string;
}

class ProxyManager {
    private appConfig: IAppConfigReader | null = null;
    private updateWorkerProxy: ((proxyUrl: string | null) => void) | null = null;

    async setup(opts: {
        appConfig: IAppConfigReader;
        updateWorkerProxy: (proxyUrl: string | null) => void;
    }) {
        this.appConfig = opts.appConfig;
        this.updateWorkerProxy = opts.updateWorkerProxy;

        // 处理认证代理（login 事件在 app 对象上）
        app.on('login', (event, _webContents, _details, authInfo, callback) => {
            if (authInfo.isProxy && this.appConfig) {
                const user = this.appConfig.getConfigByKey('network.proxy.username');
                if (user) {
                    event.preventDefault();
                    const pass = this.appConfig.getConfigByKey('network.proxy.password');
                    callback(user, pass ?? '');
                }
            }
        });

        await this.apply();

        this.appConfig.onConfigUpdated((patch) => {
            if (PROXY_CONFIG_KEYS.some((k) => k in patch)) {
                this.apply();
            }
        });
    }

    /** 根据当前配置构建代理信息，未启用时返回 null */
    private buildProxyConfig(): IProxyConfig | null {
        if (!this.appConfig) return null;

        const enabled = this.appConfig.getConfigByKey('network.proxy.enabled');
        const host = this.appConfig.getConfigByKey('network.proxy.host');
        const port = this.appConfig.getConfigByKey('network.proxy.port');

        if (!enabled || !host || !port) return null;

        const user = this.appConfig.getConfigByKey('network.proxy.username');
        const pass = this.appConfig.getConfigByKey('network.proxy.password');
        const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@` : '';

        return { proxyUrl: `http://${auth}${host}:${port}`, host, port };
    }

    /** 将代理配置应用到所有网络出口 */
    private async apply() {
        const config = this.buildProxyConfig();

        // 1) Electron Session — 影响渲染进程所有网络请求
        if (config) {
            await session.defaultSession.setProxy({
                proxyRules: `http://${config.host}:${config.port}`,
            });
        } else {
            await session.defaultSession.setProxy({ mode: 'direct' });
        }

        // 2) 全局 axios defaults — 覆盖 downloadManager / pluginManager / 插件沙箱
        //
        // 关键：必须显式把 axios 的 proxy 置为 false。
        //
        // axios（v1）在 proxy 为 undefined 时会通过 proxy-from-env 自动读取
        // HTTP_PROXY / HTTPS_PROXY 环境变量，而它的实现是把请求「按绝对 URI 明文转发」
        // 给代理（options.host/port 被改写成代理地址），对 https 目标不做 CONNECT 隧道。
        // 结果是：只要系统/环境里存在 HTTP(S)_PROXY，即使应用内的代理开关是关闭的，
        // 所有 https 请求都会被降级成明文 HTTP 打到目标 443 端口，服务器返回
        // 400 The plain HTTP request was sent to HTTPS port（或直接 ECONNRESET），
        // 表现为「插件全部搜不到东西」。
        //
        // 代理与否完全交给下面的 agent 决定：开关关闭 = httpAgent/httpsAgent 置空 = 直连。
        axios.defaults.proxy = false;

        // 提前记下环境里的代理（下面会清掉），只用于日志提示
        const envProxyBeforeCleanup =
            process.env.HTTPS_PROXY ??
            process.env.https_proxy ??
            process.env.HTTP_PROXY ??
            process.env.http_proxy;

        if (config) {
            axios.defaults.httpAgent = new HttpProxyAgent(config.proxyUrl);
            axios.defaults.httpsAgent = new HttpsProxyAgent(config.proxyUrl);
        } else {
            axios.defaults.httpAgent = undefined;
            axios.defaults.httpsAgent = undefined;

            // 4) Node 层面也要关掉环境代理。
            //
            // axios 的 proxy:false 只管 axios 自己；Node 24+ 会读 NODE_USE_ENV_PROXY /
            // HTTP(S)_PROXY 在 http/https 模块层自己走代理，axios 拦不住。
            // 下载走的是 Node 的 https（axios），于是会偷偷经过环境里的代理，
            // 对酷我等 CDN 表现为 TLS 握手被断开：
            //   Client network socket disconnected before secure TLS connection was established
            // 播放走 Electron net 栈（已按应用设置直连）所以不受影响 —— 这就是
            // 「能在线播放、但下载全失败」的原因。
            delete process.env.NODE_USE_ENV_PROXY;
            for (const key of [
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'http_proxy',
                'https_proxy',
                'ALL_PROXY',
                'all_proxy',
            ]) {
                delete process.env[key];
            }
        }

        // 3) RequestForwarder Worker — 通过 IPC 传递代理地址
        this.updateWorkerProxy?.(config?.proxyUrl ?? null);

        // 环境变量里存在代理时打印一行提示，便于排查「明明关了代理却仍然走代理」的问题
        // 注意：上面已经把变量删掉了，这里用提前记下的值来提示
        console.log(
            '[ProxyManager] Applied proxy:',
            config ? `${config.host}:${config.port}` : 'direct',
            !config && envProxyBeforeCleanup ? `(已忽略环境代理 ${envProxyBeforeCleanup})` : '',
        );
    }
}

const proxyManager = new ProxyManager();
export default proxyManager;
