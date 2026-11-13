'use strict';

// electron/kuwo/kuwoIpc.cjs
// 酷我官方接口的主进程窄代理。
//
// 为什么需要它：搜索接口 `search.kuwo.cn` 不返回 `Access-Control-Allow-Origin`，渲染进程（file://，
// origin 为 null）的 fetch 会被浏览器层拦掉；取址与歌词有 CORS，但为了不给渲染层留三套不同的请求
// 方式，这里统一走主进程。
//
// 边界：渲染层只能传**参数**，不能传 URL。三条通道各自把参数拼进固定的端点与固定的查询串，所以
// 即便主窗口里已经跑着注入的脚本，它也只能打这三个酷我端点，不会变成通用转发（SSRF）。
// 每个请求 12s 上限；返回 `{ status, text }`，解析留给渲染层——它已经有单引号对象的解析器了。

const { net } = require('electron');

const TIMEOUT_MS = 12_000;

/** 酷我客户端认的 UA；不带 UA 也能用，带上是因为移动端接口偶尔按它选返回格式。 */
const REQUEST_HEADERS = {
  'User-Agent': 'okhttp/4.10.0',
  Accept: '*/*',
};

/** `quality` 与酷我 `br` 参数的对应。没列的档按 high 处理，理由同 customProvider：宁低勿错标。 */
const QUALITY_BR = {
  standard: '128kmp3',
  high: '320kmp3',
  lossless: '2000kflac',
  hires: '4000kflac',
};

const intIn = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

/** 搜索：`pn` 是页码（从 0 开始），`rn` 是每页条数；两者的乘积才是 offset。 */
const searchUrl = (query = {}) => {
  const limit = intIn(query.limit, 30, 1, 100);
  const offset = intIn(query.offset, 0, 0, 100_000);
  const params = new URLSearchParams({
    all: String(query.keyword ?? '').slice(0, 200),
    ft: 'music',
    itemset: 'web_2013',
    client: 'kt',
    pn: String(Math.floor(offset / limit)),
    rn: String(limit),
    rformat: 'json',
    encoding: 'utf8',
  });
  return `http://search.kuwo.cn/r.s?${params.toString()}`;
};

const audioUrl = (query = {}) => {
  const rid = String(query.rid ?? '').replace(/[^\d]/g, '');
  const br = QUALITY_BR[query.quality] || QUALITY_BR.high;
  const params = new URLSearchParams({
    f: 'web',
    source: 'kwplayer_ar_1.1.9_oppo_118980_320.apk',
    type: 'convert_url_with_sign',
    rid,
    br,
  });
  return `https://nmobi.kuwo.cn/mobi.s?${params.toString()}`;
};

const lyricUrl = (query = {}) => {
  const rid = String(query.rid ?? '').replace(/[^\d]/g, '');
  return `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}`;
};

const fetchText = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await net.fetch(url, { signal: controller.signal, headers: REQUEST_HEADERS });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    throw new Error(aborted
      ? `KuWo request timed out after ${TIMEOUT_MS} ms`
      : `KuWo request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 注册三条通道。`isTrusted(event)` 给定时，非第一方窗口的调用直接拒。
 * 测试可以传 `{ ipcMain: fake, fetchText: fake }`，不经过 Electron。
 */
const registerKuwoIpc = ({ ipcMain, isTrusted, fetch: fetchImpl = fetchText }) => {
  const guard = (channel, handler) => (event, query) => {
    if (typeof isTrusted === 'function' && !isTrusted(event.sender)) {
      throw new Error(`Untrusted renderer attempted to call the ${channel} channel.`);
    }
    return handler(query);
  };

  ipcMain.handle('kuwo-search', guard('kuwo-search', query => fetchImpl(searchUrl(query))));
  ipcMain.handle('kuwo-url', guard('kuwo-url', query => fetchImpl(audioUrl(query))));
  ipcMain.handle('kuwo-lyric', guard('kuwo-lyric', query => fetchImpl(lyricUrl(query))));
};

module.exports = {
  registerKuwoIpc,
  // 下面三个只为单测导出：它们决定请求的形状，值得单独断言。
  searchUrl,
  audioUrl,
  lyricUrl,
  QUALITY_BR,
};
