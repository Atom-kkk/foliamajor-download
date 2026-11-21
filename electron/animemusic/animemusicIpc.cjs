'use strict';

// electron/animemusic/animemusicIpc.cjs
//
// 聚合音源后端（`animemusic.bzxhkj.com`，LX 自定义源 `lx-animemusic` 3.0.1 的 HTTP 部分）的主进程窄代理。
//
// 协议只有一个动作：按「原平台 + 原平台 id」换一条地址。
//
//   POST https://animemusic.bzxhkj.com/v1/index.php/music/url
//     {"source":"wy","musicId":"2659565914","quality":"flac"}
//     -> {"code":200,"url":"https://m701.music.126.net/.../x.flac"}
//     -> {"code":500,"message":"获取URL失败"}
//
// 为什么走主进程：后端不放行浏览器侧的预检，渲染层直接 POST 会被 CORS 拦掉；和星海一样，
// 域名、路径、请求头都在这里拼死，渲染层只交 source / musicId / quality 三个白名单参数，
// 所以它不是通用转发。解析留在解析层（src/services/onlineMusic/animemusic/）。

const { createSenderGuardedHandler } = require('../ipcAccessGuard.cjs');

const TIMEOUT_MS = 10_000;
// 2026-11-21 实测：这个端点限流回 429，等一会儿再来一次就能过。
const RATE_LIMIT_BACKOFF_MS = 600;

const HOST = 'animemusic.bzxhkj.com';
const API_PATH = '/v1/index.php/music/url';

/**
 * 只接 Folia 有对应内置源的平台。
 *
 * 后端的搜索接口还认识 bilibili / 快手 / 全民K歌 / 喜马拉雅 / YouTube，但那几个平台在 Folia 里
 * 没有 provider，没有「原平台 id」可换，列在这里只会变成一个没人调的入口。
 */
const SOURCES = new Set(['wy', 'kg', 'kw', 'tx', 'qishui']);

/** 参数白名单：三个字段，值截断，source 必须在表里。 */
const buildBody = (query = {}) => {
    const source = String(query.source ?? '');
    if (!SOURCES.has(source)) {
        throw new Error(`AnimeMusic does not serve the source "${source}"`);
    }
    const musicId = String(query.musicId ?? '').trim().slice(0, 200);
    if (!musicId) {
        throw new Error('AnimeMusic needs a musicId to swap an address');
    }
    return {
        source,
        musicId,
        quality: String(query.quality ?? '128k').trim().slice(0, 16) || '128k',
    };
};

const buildUrl = () => `https://${HOST}${API_PATH}`;

const headers = (payload) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // 后端按 LX 客户端的 UA 放行；与星海代理一致。
    'User-Agent': 'lx-music',
});

/**
 * 备用通道：Node 自带的 https。
 *
 * Electron 的 `net.fetch` 走 session 的代理设置，系统代理挡掉这个域名时它会直接失败；
 * Node 的 https 只认 `http(s)_proxy` 环境变量，路径不同，常能通。
 */
const nodePost = (url, payload, timeoutMs) => new Promise((resolve, reject) => {
    const request = require('node:https').request(url, { method: 'POST', headers: headers(payload) }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode || 0, text }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.write(payload);
    request.end();
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const requestOnce = async (body) => {
    // 懒加载：这个模块的纯函数部分（拼请求体）要能在没有 Electron 的环境里被单独测。
    const { net } = require('electron');
    const url = buildUrl();
    const payload = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let answer;
    try {
        const response = await net.fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: headers(payload),
            body: payload,
        });
        answer = { status: response.status, text: await response.text() };
    } catch (error) {
        const aborted = error && error.name === 'AbortError';
        if (!aborted) {
            // 代理/证书层面的失败：换 Node 的 https 再试一次同一条地址。
            try {
                return await nodePost(url, payload, TIMEOUT_MS);
            } catch {
                // 两条路都不通，报原来的错误。
            }
        }
        throw new Error(aborted
            ? `AnimeMusic request timed out after ${TIMEOUT_MS} ms`
            : `AnimeMusic request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
        clearTimeout(timer);
    }

    if (answer.status === 429) {
        await sleep(RATE_LIMIT_BACKOFF_MS);
        try {
            const retry = await net.fetch(url, {
                method: 'POST',
                headers: headers(payload),
                body: payload,
            });
            return { status: retry.status, text: await retry.text() };
        } catch {
            // 重试失败就交回 429，让上层按「这个源现在给不了」处理。
        }
    }
    return answer;
};

const registerAnimemusicIpc = ({ ipcMain, isTrusted, request: requestImpl = requestOnce }) => {
    // 来源校验走登记的守卫工厂（electron/ipcAccessGuard.cjs，D605）。
    const guarded = (channel, handler) => createSenderGuardedHandler({
        channel,
        isTrusted: (event) => typeof isTrusted !== 'function' || isTrusted(event.sender),
        handler: (_event, query) => handler(query),
    });

    ipcMain.handle('animemusic-url', guarded('animemusic-url', (query) => requestImpl(buildBody(query))));
};

module.exports = {
    registerAnimemusicIpc,
    // 只为单测导出：参数白名单值得单独断言。
    buildBody,
    buildUrl,
    SOURCES,
};
