import type { AudioQualityPreference, OnlineProviderId } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/xinghai/xinghai.ts
//
// 星海音源后端（LX 自定义源「星海音乐源 v3.2.15」的 HTTP 部分）：一个 GET 换一个地址。
//
//   GET https://yy.zddyr.top/lx/api/?source=<wy|tx|kg|mg|qs>&songmid=<id>&name=&singer=&quality=<128k|320k|flac>
//     -> { code: 200, url, quality, format, lrc, picture }
//     -> { code: 403 | 429 | 500 | 503, msg }
//
// 后端认 `X-Token` / `X-Client` 两个自定义头，而它的 OPTIONS 预检回 405——渲染层带这两个头的
// fetch 会被浏览器层拦掉，所以请求走主进程的窄代理（electron/xinghai/xinghaiIpc.cjs）。
//
// 这里只做「按原平台 id 换地址」，不做搜索：星海没有搜索接口。它的价值是给内置源里那些
// 「确定放不出来」的歌（会员/付费/灰歌）换一条路，而不是当第二个搜索源。酷我不在此列——
// 那个平台由 kuwo/ 的直连源负责，不重复。

export const XINGHAI_SOURCE_ID: OnlineProviderId = 'xinghai';

/** 后端认识的平台缩写。酷我（kw）故意不在内：内置的直连源已经覆盖它。 */
export type XinghaiPlatform = 'wy' | 'tx' | 'kg' | 'mg' | 'qs';

/**
 * Folia 的 provider 到星海的平台缩写。只列 mediaId 能直接当后端 id 用的两个：一个的 mediaId
 * 就是它的数字 id，另一个的 mediaId 就是 songmid。第三个平台的 mediaId 是 hash，而后端要的是
 * 数字 id + hash 两样，对不上就宁可不接。
 */
const PLATFORM_BY_PROVIDER: Partial<Record<OnlineProviderId, XinghaiPlatform>> = {
    netease: 'wy',
    qq: 'tx',
};

const bridge = () => (typeof window === 'undefined' ? undefined : window.electron);

export const isXinghaiAvailable = (): boolean => Boolean(bridge()?.xinghaiAudioUrl);

export const xinghaiPlatformOf = (providerId: OnlineProviderId): XinghaiPlatform | null => (
    PLATFORM_BY_PROVIDER[providerId] ?? null
);

const qualityParam = (quality: AudioQualityPreference): string => {
    if (quality === 'hires') return 'flac24bit';
    if (quality === 'lossless') return 'flac';
    if (quality === 'high') return '320k';
    return '128k';
};

/** 后端回的 `quality` 是它自己的词（320k / flac / flac24bit 一类）。 */
const qualityOf = (served: string): AudioQualityPreference => {
    const value = served.toLowerCase();
    if (/flac24bit|hires|jymaster|sky|24bit/.test(value)) return 'hires';
    if (/flac|lossless/.test(value)) return 'lossless';
    if (/320|192/.test(value)) return 'high';
    return 'standard';
};

export type XinghaiAudio = {
    url: string;
    quality: AudioQualityPreference;
    /** 后端说的格式（mp3 / flac），只用于日志与诊断。 */
    format?: string;
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 把后端回答读成地址。纯函数：单测直接喂样本。 */
export const parseXinghaiAudio = (text: string): XinghaiAudio => {
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new OnlineProviderError('invalid-response', `星海音源的回答不是 JSON：${text.slice(0, 80)}`, XINGHAI_SOURCE_ID);
    }
    const code = Number(body?.code);
    if (code !== 200) {
        const message = typeof body?.msg === 'string' && body.msg ? body.msg : `code ${String(body?.code)}`;
        // 403/429/503 是「这个源现在给不了」，交给路由回退到内置源的原始行为；
        // 500 是「这首歌它也没有」，两种情况都不该被说成「已播放」。
        const unavailable = code === 403 || code === 429 || code === 503;
        throw new OnlineProviderError(
            unavailable ? 'unavailable' : 'not-playable',
            `星海音源：${message}`,
            XINGHAI_SOURCE_ID,
            body,
            code,
        );
    }
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) {
        throw new OnlineProviderError('not-playable', '星海音源的回答里没有可播放的地址', XINGHAI_SOURCE_ID, body);
    }
    return {
        url,
        quality: qualityOf(String(body?.quality ?? '')),
        ...(typeof body?.format === 'string' && body.format ? { format: body.format } : {}),
    };
};

export type XinghaiRequest = {
    providerId: OnlineProviderId;
    mediaId: string;
    name?: string;
    singer?: string;
    /** 秒。后端用它挑更接近的那一首。 */
    interval?: number;
    albumName?: string;
};

export const fetchXinghaiAudio = async (request: XinghaiRequest, quality: AudioQualityPreference): Promise<XinghaiAudio> => {
    const platform = xinghaiPlatformOf(request.providerId);
    if (!platform) {
        throw new OnlineProviderError('unsupported', `星海音源不接这个平台：${request.providerId}`, XINGHAI_SOURCE_ID);
    }
    const call = bridge()?.xinghaiAudioUrl;
    if (!call) {
        throw new OnlineProviderError('unavailable', '星海音源只在桌面端可用（需要主进程代理）', XINGHAI_SOURCE_ID);
    }
    let answer: { status: number; text: string };
    try {
        answer = await call({
            source: platform,
            songmid: request.mediaId,
            name: request.name,
            singer: request.singer,
            albumName: request.albumName,
            ...(request.interval && request.interval > 0 ? { interval: String(Math.round(request.interval)) } : {}),
            quality: qualityParam(quality),
        });
    } catch (error) {
        throw new OnlineProviderError('network', `星海音源请求失败：${describe(error)}`, XINGHAI_SOURCE_ID, error);
    }
    if (answer.status >= 500) {
        throw new OnlineProviderError('unavailable', `星海音源暂时不可用（HTTP ${answer.status}）`, XINGHAI_SOURCE_ID, undefined, answer.status);
    }
    return parseXinghaiAudio(answer.text);
};
