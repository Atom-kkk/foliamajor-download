'use strict';

// electron/xinghai/xinghaiIpc.cjs
//
// 星海音源后端（`yy.zddyr.top/lx/api/`，备份 `zrcdy.dpdns.org`）的主进程窄代理。
//
// 为什么必须走主进程：后端认 `X-Token` / `X-Client` 两个自定义头，而它的 OPTIONS 预检回 405，
// 渲染层带自定义头的 fetch 会在浏览器层被拦（`access-control-allow-origin: *` 有，但没放行头）。
//
// 边界：渲染层只传参数，域名、路径、请求头都由这里拼死；参数按白名单逐个取值，所以它不会变成
// 通用转发。协议来自 LX 自定义源「星海音乐源 v3.2.15」：一个 GET 换一个地址。
//
// `X-Token` 是客户端自签的 base64 JSON（device_id / ip / timestamp / random），无签名校验；
// device_id 在进程生命周期内固定，token 60 秒换一次。

const TIMEOUT_MS = 8_000;
// token 里带服务端会校验的 timestamp。以前缓存 60 秒，正好卡在过期边界上：复用到最后一秒的
// token 会被当成过期拒绝，而 4xx 又不重试，于是同一首歌一会儿能播、一会儿只剩试听。
// 现在只复用 30 秒，并且遇到 401/403 立刻换一枚再试一次。
const TOKEN_TTL_MS = 30_000;

/** 主域名与备份域名。主域名连不上或回 5xx 时换下一个。 */
const HOSTS = ['yy.zddyr.top', 'zrcdy.dpdns.org'];
const API_PATH = '/lx/api/';

/** 后端认识的平台缩写。酷我（kw）不在内：那个平台由内置的直连源负责，不重复。 */
const SOURCES = new Set(['wy', 'tx', 'kg', 'mg', 'qs']);

/** 参数白名单：名字与顺序都固定，值截断，避免被当成任意转发。 */
const PARAM_KEYS = ['source', 'name', 'singer', 'songmid', 'hash', 'albumId', 'interval', 'albumName', 'quality'];

const deviceId = `lx-online-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
let token = '';
let tokenAt = 0;

const tokenNow = () => {
    if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
    token = Buffer.from(JSON.stringify({
        device_id: deviceId,
        ip: '0.0.0.0',
        timestamp: Math.floor(Date.now() / 1000),
        random: Math.random().toString(36).slice(2, 12),
    })).toString('base64');
    tokenAt = Date.now();
    return token;
};

const buildQuery = (query = {}) => {
    const params = new URLSearchParams();
    for (const key of PARAM_KEYS) {
        const value = query[key];
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value).slice(0, 200));
    }
    return params;
};

const buildUrl = (host, query) => `https://${host}${API_PATH}?${buildQuery(query).toString()}`;

const headers = () => ({
    'X-Token': tokenNow(),
    'X-Client': 'Folia/0.7.21 (macOS)',
    'User-Agent': 'lx-music',
    Accept: 'application/json',
});

/**
 * 备用通道：Node 自带的 https。
 *
 * Electron 的 `net.fetch` 走 session 的代理设置；系统代理把这个域名挡掉时它会直接失败。
 * Node 的 https 只认 `http(s)_proxy` 环境变量，路径不同，常能通——同一首一会儿能放、
 * 一会儿只剩试听，很多就是这两条路表现不一致造成的。
 */
const nodeGet = (url, timeoutMs) => new Promise((resolve, reject) => {
    const request = require('node:https').get(url, { headers: headers() }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode || 0, text: body }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
});

const requestOnce = async (host, query) => {
    // 懒加载：这个模块的纯函数部分（拼 URL）要能在没有 Electron 的环境里被单独测。
    const { net } = require('electron');
    const url = buildUrl(host, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await net.fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: headers(),
        });
        const text = await response.text();
        return { status: response.status, text };
    } catch (error) {
        const aborted = error && error.name === 'AbortError';
        // 代理/证书层面的失败：换 Node 的 https 再试一次同一条地址。
        if (!aborted) {
            try {
                return await nodeGet(url, TIMEOUT_MS);
            } catch {
                // 两条路都不通，报原来的错误。
            }
        }
        throw new Error(aborted
            ? `XingHai request timed out after ${TIMEOUT_MS} ms`
            : `XingHai request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        clearTimeout(timer);
    }
};

/**
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 先主域名，5xx/网络错误再换备份；4xx 是明确的拒绝，不重试（除了下面两类可恢复的）。 */
const fetchFromHosts = async (query) => {
    let last = null;
    for (const host of HOSTS) {
        try {
            let answer = await requestOnce(host, query);

            // token 可能刚好过期：换一枚，同一个域名再问一次。
            if (answer.status === 401 || answer.status === 403) {
                tokenAt = 0;
                answer = await requestOnce(host, query);
            }

            // 限流：等一小会儿再试一次，别把它当成「这首没有完整版」。
            if (answer.status === 429) {
                await sleep(400);
                answer = await requestOnce(host, query);
            }

            if (answer.status < 500) return answer;
            last = new Error(`XingHai ${host} answered HTTP ${answer.status}`);
        } catch (error) {
            last = error;
        }
    }
    throw last || new Error('XingHai has no host left to try');
};

const registerXinghaiIpc = ({ ipcMain, isTrusted, fetch: fetchImpl = fetchFromHosts }) => {
    ipcMain.handle('xinghai-url', (event, query) => {
        if (typeof isTrusted === 'function' && !isTrusted(event.sender)) {
            throw new Error('Untrusted renderer attempted to call the xinghai-url channel.');
        }
        const source = String(query?.source ?? '');
        if (!SOURCES.has(source)) {
            throw new Error(`XingHai does not serve the source "${source}"`);
        }
        return fetchImpl({ ...query, source });
    });
};

module.exports = {
    registerXinghaiIpc,
    // 只为单测导出：请求形状值得单独断言。
    buildUrl,
    buildQuery,
    SOURCES,
    HOSTS,
};
