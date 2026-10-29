'use strict';

// electron/downloads/audioDownload.cjs
// 把一条音频地址存成本地文件：先让用户选保存位置，再用主进程的 net 流式写盘。
//
// 为什么在主进程做：渲染层 fetch 音频地址会遇到 CDN 的 CORS 差异，几十 MB 的 Blob 还要在页面里
// 再过一遍内存；`net.fetch` 直接落盘，页面只负责提供地址与文件名。
//
// 边界：`url` 只收 http(s)；扩展名按白名单（不是任意后缀）；保存路径只来自 dialog 的结果，
// 渲染层给不了路径，所以这个通道写不出用户没有亲自选过的位置。

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ALLOWED_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus']);

/** Windows/macOS 都不接受这些字符；同时去掉控制字符与首尾的点。 */
const sanitizeName = (value) => String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/^\.+|\s+$/g, '')
    .slice(0, 120);

const extensionOf = (value, fallback = 'mp3') => {
    const normalized = String(value ?? '').toLowerCase().replace(/^\./, '');
    return ALLOWED_EXTENSIONS.has(normalized) ? normalized : fallback;
};

/** 缓存条目只记 mimeType，保存对话框要一个扩展名。 */
const MIME_EXTENSIONS = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
};

const extensionFromMime = (mimeType) => MIME_EXTENSIONS[String(mimeType ?? '').toLowerCase()] || 'mp3';

const registerAudioDownloadIpc = ({ ipcMain, isTrusted, getWindow, app, dialog, getCachePaths }) => {
    /** 弹保存框，把建议名规范成 `名字.扩展名`。返回用户选的路径，取消时 null。 */
    const pickTarget = async (extension, suggestedName) => {
        const window = typeof getWindow === 'function' ? getWindow() : null;
        const options = {
            title: 'Save audio',
            defaultPath: path.join(app.getPath('downloads'), suggestedName),
            filters: [
                { name: extension.toUpperCase(), extensions: [extension] },
                { name: 'All files', extensions: ['*'] },
            ],
        };
        const result = window && !window.isDestroyed()
            ? await dialog.showSaveDialog(window, options)
            : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
    };

    const suggestedNameFor = (baseName, extension) => {
        const safe = sanitizeName(baseName) || 'folia-audio';
        return safe.toLowerCase().endsWith(`.${extension}`)
            ? safe
            : `${safe.replace(/\.[^.]+$/, '')}.${extension}`;
    };

    ipcMain.handle('download-audio', async (event, payload) => {
        if (typeof isTrusted === 'function' && !isTrusted(event.sender)) {
            throw new Error('Untrusted renderer attempted to call the download-audio channel.');
        }

        const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
        if (!/^https?:\/\//i.test(url)) {
            throw new Error('Only http(s) audio URLs can be downloaded.');
        }

        const extension = extensionOf(payload?.extension);
        const target = await pickTarget(extension, suggestedNameFor(payload?.defaultName, extension));
        if (!target) {
            return { canceled: true, filePath: null, bytes: 0 };
        }

        // 用主进程的 net.fetch：它走 Electron 的 session（代理、证书策略与播放器一致），
        // 而 Node 的全局 fetch 走 undici 自己的配置。懒加载是为了下面的纯函数能被单测直接引。
        const { net } = require('electron');
        const response = await net.fetch(url, { redirect: 'follow' });
        if (!response.ok || !response.body) {
            throw new Error(`The audio host answered HTTP ${response.status}.`);
        }

        // 先写 .part 再改名：中途失败不会留下一个看起来完整的文件。
        const partial = `${target}.part`;
        let bytes = 0;
        try {
            const body = Readable.fromWeb(response.body);
            body.on('data', chunk => { bytes += chunk.length; });
            await pipeline(body, fs.createWriteStream(partial));
            await fs.promises.rename(partial, target);
        } catch (error) {
            await fs.promises.rm(partial, { force: true }).catch(() => {});
            throw error;
        }

        return { canceled: false, filePath: target, bytes };
    });

    /**
     * 把播放时缓存的那份字节直接存成文件。
     *
     * 这是下载最可信的一条路：缓存里的就是播放器正在用的那个文件，所以「下的不是听的这一首」
     * 从根上不会发生。`fromCache: false` 表示这首没缓存，调用方回落到按地址下载。
     */
    if (typeof getCachePaths === 'function') {
        ipcMain.handle('download-cached-audio', async (event, payload) => {
            if (typeof isTrusted === 'function' && !isTrusted(event.sender)) {
                throw new Error('Untrusted renderer attempted to call the download-cached-audio channel.');
            }

            const cacheKey = typeof payload?.cacheKey === 'string' ? payload.cacheKey.trim() : '';
            if (!cacheKey) throw new Error('A cache key is required to save a cached song.');

            const { dataPath, metaPath } = getCachePaths(cacheKey);
            const stat = await fs.promises.stat(dataPath).catch(() => null);
            if (!stat?.isFile() || stat.size <= 0) {
                return { canceled: false, fromCache: false, filePath: null, bytes: 0 };
            }
            const meta = await fs.promises.readFile(metaPath, 'utf8')
                .then(text => JSON.parse(text))
                .catch(() => ({}));
            const extension = extensionOf(extensionFromMime(meta?.mimeType));

            const target = await pickTarget(extension, suggestedNameFor(payload?.defaultName, extension));
            if (!target) {
                return { canceled: true, fromCache: true, filePath: null, bytes: 0 };
            }
            await fs.promises.copyFile(dataPath, target);
            return { canceled: false, fromCache: true, filePath: target, bytes: stat.size };
        });
    }
};

module.exports = {
    registerAudioDownloadIpc,
    sanitizeName,
    extensionOf,
    extensionFromMime,
    ALLOWED_EXTENSIONS,
};
