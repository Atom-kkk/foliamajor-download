'use strict';

// electron/audioSizeProbe.cjs
//
// 量一条音频地址的字节数，用来判断它是不是被截断的片段。
//
// 为什么需要它：`<audio preload="metadata">` 拿时长是首选，但它在某些地址上会失败（一次性的
// 签名 URL、被 CDN 拒绝的第二次请求、容器格式不被识别）。失败时如果就此放过，一条 800 KB 的
// 30 秒试听就会被当成整首——这正是「明明有完整版却只放 30 秒」的来源。
//
// 字节数是第二道判据：一首 4 分 51 秒的歌，即使按 48 kbps 算也要 1.7 MB；只有 800 KB 就说明
// 它不可能是整首。HEAD 不给长度时退回 `Range: bytes=0-0` 读 `Content-Range`。

const { net } = require('electron');

const TIMEOUT_MS = 8_000;

const fetchWithLimit = async (url, options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await net.fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};

const sizeOf = async (url) => {
    try {
        const head = await fetchWithLimit(url, { method: 'HEAD' });
        const length = Number(head.headers.get('content-length'));
        if (Number.isFinite(length) && length > 0) return length;
    } catch {
        // 有的 CDN 直接拒绝 HEAD，走下面的 Range。
    }
    try {
        const ranged = await fetchWithLimit(url, { headers: { Range: 'bytes=0-0' } });
        const contentRange = ranged.headers.get('content-range') || '';
        const total = Number(contentRange.split('/')[1]);
        if (Number.isFinite(total) && total > 0) return total;
        const length = Number(ranged.headers.get('content-length'));
        if (Number.isFinite(length) && length > 0) return length;
    } catch {
        // 两次都拿不到：返回 null，调用方按「不确定」处理。
    }
    return null;
};

const registerAudioSizeProbeIpc = ({ ipcMain, isTrusted }) => {
    ipcMain.handle('probe-audio-size', async (event, url) => {
        if (typeof isTrusted === 'function' && !isTrusted(event.sender)) {
            throw new Error('Untrusted renderer attempted to call the probe-audio-size channel.');
        }
        const target = typeof url === 'string' ? url.trim() : '';
        if (!/^https?:\/\//i.test(target)) return null;
        return sizeOf(target);
    });
};

module.exports = { registerAudioSizeProbeIpc, sizeOf };
