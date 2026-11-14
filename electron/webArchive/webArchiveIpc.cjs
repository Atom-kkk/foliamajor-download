'use strict';

// electron/webArchive/webArchiveIpc.cjs
//
// 网页存档站（「歌曲宝」gequbao.com）的主进程读取器。
//
// 为什么需要它：兜底链的前四步全部依赖能拿到「平台 id」——星海按 id 换址、酷我按 id 搜。
// 但有些歌三个曲库（网易云 / 酷狗 / 酷我）都没有原版，只有这些「网页存档站」有：它们把
// 用户上传的文件放在自己的曲库里，跟平台的版权没关系。2026-11-14 实测的对比：
//
//   说好的幸福呢 / 周杰伦 —— 网易云前 15 条全是翻唱，酷我只有 DJ 版，酷狗这一轮能换到；
//   偏爱 / 张芸京 —— 酷我 20 条全是 Live / cover / 改编；
//   而 gequbao 搜第一条就是原版，换出来的地址是 256.8 s / 213.0 s 的完整 mp3。
//
// 它只有一条路：搜索页 HTML → 详情页里的 `play_id` → POST `/member/common-play-url`。
// 没有公开 API、没有签名，所以要一个 HTML 解析器。解析放在主进程：渲染层同源策略取不到，
// 而且不该把 DOM 解析塞进播放路径。
//
// 边界（这段是安全边界，不是风格问题）：
//   - 域名、路径、请求头都写死在这个文件里；渲染层只能给一个关键词（截断 80 字）或一个数字 id。
//   - id 必须匹配 /^\d{1,12}$/，所以它不会被当成任意 URL 的转发器。
//   - 只允许 http(s) 的音频地址出门。
//   - 请求串行排队、每个关键词最多取 12 条候选：这些站有速率限制，并发只会一起被拒。

const { createSenderGuardedHandler } = require('../ipcAccessGuard.cjs');

const BASE = 'https://www.gequbao.com';
const TIMEOUT_MS = 12_000;
const MAX_HITS = 12;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const decodeEntities = (text) => String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

/**
 * 搜索页里每一行是
 *   <a href="/music/44239" title="为你写的歌 - 方大同">
 * 标题里可能自带破折号（「有一种悲伤 - 电影《…》主题曲 - A-Lin」），所以从**最后一个**分隔符切。
 */
const parseSearchPage = (html) => {
    const seen = new Set();
    const hits = [];
    const pattern = /href="\/music\/(\d{1,12})"[^>]*?title="([^"]+)"/g;
    let match = pattern.exec(html);
    while (match && hits.length < MAX_HITS) {
        const id = match[1];
        const label = decodeEntities(match[2]);
        if (!seen.has(id)) {
            seen.add(id);
            const cut = label.lastIndexOf(' - ');
            const title = cut > 0 ? label.slice(0, cut).trim() : label;
            const artist = cut > 0 ? label.slice(cut + 3).trim() : '';
            if (title) hits.push({ id, title, artist });
        }
        match = pattern.exec(html);
    }
    return hits;
};

/**
 * 详情页把取址所需的令牌放在 `window.appData = JSON.parse('…')` 里。那一段是被 \u0022 转义过的
 * JSON（单引号字符串里不能再放双引号），所以先把转义还原，再按字段取值。
 *
 * 不整体 `JSON.parse`：里面的标题字段同样带转义，还原后可能不再合法；而这里只需要一个 id，
 * 按字段取更稳，也不会因为某个不认识的字段格式变化就整块失败。
 */
const parsePlayId = (html) => {
    const match = /window\.appData\s*=\s*JSON\.parse\('([\s\S]*?)'\)\s*;/.exec(html);
    if (!match) return '';
    const normalized = match[1].replace(/\\u0022/g, '"').replace(/\\\//g, '/');
    const found = /"play_id"\s*:\s*"([^"]{8,512})"/.exec(normalized);
    return found ? found[1] : '';
};

/** 取址回答：`{ code: 1, data: { url } }`。 */
const parsePlayUrl = (text) => {
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return '';
    }
    const url = body && body.data && typeof body.data.url === 'string' ? body.data.url.trim() : '';
    return /^https?:\/\//i.test(url) ? url : '';
};

const requestOnce = async (url, init = {}) => {
    const { net } = require('electron');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await net.fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                'User-Agent': UA,
                Accept: init.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                Referer: `${BASE}/`,
                ...(init.headers || {}),
            },
        });
        const text = await response.text();
        return { status: response.status, text };
    } finally {
        clearTimeout(timer);
    }
};

// 串行队列：这些站有速率限制，几首歌同时失败时并发问只会一起被拒。
let queue = Promise.resolve();
const inQueue = (task) => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
};

const search = async (keyword) => {
    const word = String(keyword || '').trim().slice(0, 80);
    if (!word) return [];
    const answer = await inQueue(() => requestOnce(`${BASE}/s/${encodeURIComponent(word)}`));
    if (answer.status !== 200) {
        throw new Error(`gequbao search answered HTTP ${answer.status}`);
    }
    return parseSearchPage(answer.text);
};

const resolve = async (id) => {
    const key = String(id || '').trim();
    if (!/^\d{1,12}$/.test(key)) throw new Error('gequbao resolve needs a numeric music id');
    return inQueue(async () => {
        const page = await requestOnce(`${BASE}/music/${key}`);
        if (page.status !== 200) throw new Error(`gequbao page answered HTTP ${page.status}`);
        const playId = parsePlayId(page.text);
        if (!playId) throw new Error('gequbao page carried no play token');

        // 令牌是一次性的：同一首两次取址会得到两个不同的签名地址，所以这里不缓存地址。
        const body = new URLSearchParams({ id: playId, purpose: 'play' }).toString();
        const answer = await requestOnce(`${BASE}/member/common-play-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
            accept: 'application/json',
            body,
        });
        if (answer.status !== 200) throw new Error(`gequbao play-url answered HTTP ${answer.status}`);
        const url = parsePlayUrl(answer.text);
        if (!url) throw new Error('gequbao play-url carried no address');
        return url;
    });
};

const registerWebArchiveIpc = ({ ipcMain, isTrusted, search: searchImpl = search, resolve: resolveImpl = resolve }) => {
    const guarded = (channel, handler) => createSenderGuardedHandler({
        channel,
        isTrusted: (event) => typeof isTrusted !== 'function' || isTrusted(event.sender),
        handler: (_event, payload) => handler(payload),
    });

    ipcMain.handle('web-archive-search', guarded('web-archive-search', (payload) => (
        searchImpl(payload && payload.keyword)
    )));

    ipcMain.handle('web-archive-url', guarded('web-archive-url', (payload) => (
        resolveImpl(payload && payload.id)
    )));
};

module.exports = {
    registerWebArchiveIpc,
    // 只为单测导出：页面结构值得单独断言。
    parseSearchPage,
    parsePlayId,
    parsePlayUrl,
    BASE,
};
