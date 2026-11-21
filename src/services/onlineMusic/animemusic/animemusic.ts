import type { AudioQualityPreference, OnlineProviderId } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/animemusic/animemusic.ts
//
// 聚合音源后端（LX 自定义源 `lx-animemusic` 3.0.1 的 HTTP 部分）：按「原平台 + 原平台 id」换一条地址。
//
//   POST https://animemusic.bzxhkj.com/v1/index.php/music/url
//     {"source":"wy","musicId":"2659565914","quality":"flac"}
//     -> { code: 200, url }
//     -> { code: 500, message: "获取URL失败" }
//     -> { code: 429, message: ... }        // 限流，等一会儿可重试
//
// 与星海的分工：星海只免费换址，会员曲拿不到；这一个后端对网易云、酷狗的会员曲会给完整文件
// （2026-11-21 实测：网易云 `fee=1` 的《天亮以前说再见》回 128k mp3 3.73 MB / flac 24.7 MB，
// 均与 233 s 的歌长吻合；酷狗原版同样给完整 mp3 与 flac）。它不做免费/付费区分，也不看这个账号
// 有没有会员——地址是它自己解析出来的，所以只能当**兜底链里靠后的候选**，不能替内置源做正路。
//
// 覆盖与实测限制（同日）：
//   - `wy` 网易云：完整 mp3 / flac；
//   - `kg` 酷狗：完整 mp3 / flac；
//   - `kw` 酷我：后端转给 `yy.zddyr.top/lx/api/kwplay.php`，也就是星海那一条路，没有额外能力；
//   - `tx` QQ：回 `{"code":500,"message":"获取URL失败"}`；
//   - `qishui` 汽水：VIP 曲仍然只给 30 秒（返回的是它自己的代理地址，487 KB ≈ 30 s）。
//
// 所以它真正补上的缺口只有一个：**网易云的会员曲**。其余平台在兜底链里排在星海之后，多了也不碍事。
//
// 它没有搜索接口（后端有，但 Folia 不需要第二个搜索源），所以这里只做「换地址」。

export const ANIMEMUSIC_SOURCE_ID: OnlineProviderId = 'animemusic';

/** 后端认识的平台缩写。 */
export type AnimemusicSource = 'wy' | 'kg' | 'kw' | 'tx' | 'qishui';

/**
 * Folia 的 provider 到后端的平台缩写。
 *
 * 只登记「mediaId 能直接当后端 id 用」的平台：网易云数字 id、酷狗 hash、酷我 rid、QQ songmid、
 * 汽水 trackId。Spotify / YT Music / 波点 / Apple Music 的 id 后端不认识，不列。
 */
const SOURCE_BY_PROVIDER: Partial<Record<OnlineProviderId, AnimemusicSource>> = {
    netease: 'wy',
    kugou: 'kg',
    kuwo: 'kw',
    qq: 'tx',
    qishui: 'qishui',
};

const bridge = () => (typeof window === 'undefined' ? undefined : window.electron);

export const isAnimemusicAvailable = (): boolean => Boolean(bridge()?.animemusicAudioUrl);

export const animemusicSourceOf = (providerId: OnlineProviderId): AnimemusicSource | null => (
    SOURCE_BY_PROVIDER[providerId] ?? null
);

export const animemusicQualityParam = (quality: AudioQualityPreference): string => {
    if (quality === 'hires') return 'flac24bit';
    if (quality === 'lossless') return 'flac';
    if (quality === 'high' || quality === 'ultra') return '320k';
    return '128k';
};

const pathOf = (url: string): string => {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return url.toLowerCase().split('?')[0] ?? '';
    }
};

/**
 * 报哪一档。
 *
 * 后端的回答只有 `{code, url}`，没有星海那样的 `quality` 字段，所以只能从地址看：
 * 路径是 `.flac` 就是无损；mp3 / 代理地址（酷我的 `kwplay.php`、汽水的转发地址）按被问的档记，
 * 但最高记到 `high`——再往上写就是替后端保证「24 bit」，它没这么说。
 */
export const servedQuality = (url: string, asked: AudioQualityPreference): AudioQualityPreference => {
    const path = pathOf(url);
    if (path.endsWith('.flac')) return 'lossless';
    if (asked === 'high' || asked === 'ultra' || asked === 'lossless' || asked === 'hires') return 'high';
    return 'standard';
};

export type AnimemusicAudio = {
    url: string;
    quality: AudioQualityPreference;
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 后端回答的形状：成功带 url，失败带 message（旧版脚本里叫 msg）。字段都是 unknown，逐个验。 */
type RawAnswer = { code?: unknown; url?: unknown; message?: unknown; msg?: unknown };

/** 把后端的回答读成地址。纯函数：单测直接喂样本。 */
export const parseAnimemusicAudio = (text: string, asked: AudioQualityPreference = 'standard'): AnimemusicAudio => {
    let body: RawAnswer;
    try {
        body = JSON.parse(text) as RawAnswer;
    } catch {
        throw new OnlineProviderError('invalid-response', `聚合音源的回答不是 JSON：${text.slice(0, 80)}`, ANIMEMUSIC_SOURCE_ID);
    }
    const code = Number(body.code);
    if (code !== 200) {
        const message = typeof body.message === 'string' && body.message
            ? body.message
            : typeof body.msg === 'string' && body.msg ? body.msg : `code ${String(body.code)}`;
        // 429 是「这个源现在给不了」，403 是后端要认证：两种情况都交给路由回退，不当作「这首没有」。
        const unavailable = code === 403 || code === 429 || code === 503;
        throw new OnlineProviderError(
            unavailable ? 'unavailable' : 'not-playable',
            `聚合音源：${message}`,
            ANIMEMUSIC_SOURCE_ID,
            body,
            code,
        );
    }
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) {
        throw new OnlineProviderError('not-playable', '聚合音源的回答里没有可播放的地址', ANIMEMUSIC_SOURCE_ID, body);
    }
    return { url, quality: servedQuality(url, asked) };
};

export type AnimemusicRequest = {
    providerId: OnlineProviderId;
    mediaId: string;
};

export const fetchAnimemusicAudio = async (
    request: AnimemusicRequest,
    quality: AudioQualityPreference,
): Promise<AnimemusicAudio> => {
    const source = animemusicSourceOf(request.providerId);
    if (!source) {
        throw new OnlineProviderError('unsupported', `聚合音源不接这个平台：${request.providerId}`, ANIMEMUSIC_SOURCE_ID);
    }
    const call = bridge()?.animemusicAudioUrl;
    if (!call) {
        throw new OnlineProviderError('unavailable', '聚合音源只在桌面端可用（需要主进程代理）', ANIMEMUSIC_SOURCE_ID);
    }
    if (!request.mediaId) {
        throw new OnlineProviderError('unsupported', '聚合音源需要原平台的歌曲 id', ANIMEMUSIC_SOURCE_ID);
    }
    let answer: { status: number; text: string };
    try {
        answer = await call({
            source,
            musicId: request.mediaId,
            quality: animemusicQualityParam(quality),
        });
    } catch (error) {
        throw new OnlineProviderError('network', `聚合音源请求失败：${describe(error)}`, ANIMEMUSIC_SOURCE_ID, error);
    }
    if (answer.status >= 500) {
        throw new OnlineProviderError('unavailable', `聚合音源暂时不可用（HTTP ${answer.status}）`, ANIMEMUSIC_SOURCE_ID, undefined, answer.status);
    }
    return parseAnimemusicAudio(answer.text, quality);
};
