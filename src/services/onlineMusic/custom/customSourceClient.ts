import type { UnifiedSong } from '../../../types';
import type { AudioQualityPreference, ProviderAudioSource, ProviderPage } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { CustomSourceConfig } from './customSourceConfig';
import { CUSTOM_SOURCE_ID, readCustomSourceConfig } from './customSourceConfig';
import { toSafePlaybackUrl } from '../../../utils/appPlaybackHelpers';

// src/services/onlineMusic/custom/customSourceClient.ts
//
// 自定义音源的 HTTP 合同。这里只说「一个能搜、能给地址的 HTTP 服务长什么样」，
// 服务本身（自建代理、别人的音乐 API、本地脚本）在仓库之外。
//
//   GET {base}/search?keyword=<词>&limit=<n>&offset=<n>
//     -> { items: [ { id, name, artist | artists, album, duration | durationMs, cover } ], total?, hasMore? }
//        也收 { songs: [...] } / { data: [...] } / 直接一个数组。
//
//   GET {base}/url?id=<id>&quality=<standard|high|lossless|hires>&title=&artist=&album=&duration=
//     -> { url, quality?, expiresAt?, preview? }        // 也收 { data: { url } } / { playUrl }
//        返回 404 表示这个 id 没有可播地址（等于「没有」），不是服务故障。
//
//   GET {base}/lyric?id=<id>                            // 可选
//     -> { lrc, translated? }                           // 也收 { lyric } / { data: { lrc } }
//
// 任何形状不对的回答都抛 `invalid-response`：静默返回空列表会让「没搜到」和「服务答错了」
// 变成同一件事，而这两种情况在用的人那里要做的事完全不同。

const REQUEST_TIMEOUT_MS = 12_000;

const asRecord = (value: unknown): Record<string, unknown> | null => (
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
);

const asString = (value: unknown): string => (
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
);

const firstString = (...values: unknown[]): string => {
    for (const value of values) {
        const text = asString(value);
        if (text) return text;
    }
    return '';
};

const pickArray = (body: unknown): unknown[] => {
    if (Array.isArray(body)) return body;
    const record = asRecord(body);
    if (!record) return [];
    for (const key of ['items', 'songs', 'data', 'result', 'list']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
        const nested = asRecord(value);
        if (nested && Array.isArray(nested.songs)) return nested.songs as unknown[];
        if (nested && Array.isArray(nested.items)) return nested.items as unknown[];
    }
    return [];
};

const requestJson = async (
    config: CustomSourceConfig,
    path: string,
    params: Record<string, string | number | undefined>,
): Promise<{ status: number; body: unknown }> => {
    if (!config.baseUrl) {
        throw new OnlineProviderError('unavailable', '自定义音源没有配置地址（VITE_CUSTOM_SOURCE_BASE 或 localStorage）', CUSTOM_SOURCE_ID);
    }
    let url: URL;
    try {
        url = new URL(`${config.baseUrl}${path}`);
    } catch {
        throw new OnlineProviderError('unavailable', `自定义音源地址不合法：${config.baseUrl}`, CUSTOM_SOURCE_ID);
    }
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        url.searchParams.set(key, String(value));
    }

    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller && typeof setTimeout === 'function'
        ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : null;
    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
            signal: controller?.signal,
        });
        const text = await response.text();
        let body: unknown = undefined;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                if (response.ok) {
                    throw new OnlineProviderError('invalid-response', `自定义音源 ${path} 的回答不是 JSON`, CUSTOM_SOURCE_ID);
                }
                body = text;
            }
        }
        return { status: response.status, body };
    } catch (error) {
        if (error instanceof OnlineProviderError) throw error;
        const aborted = (error as { name?: string } | null)?.name === 'AbortError';
        throw new OnlineProviderError(
            'network',
            aborted
                ? `自定义音源 ${path} 超时（${REQUEST_TIMEOUT_MS} ms）`
                : `自定义音源 ${path} 连不上`,
            CUSTOM_SOURCE_ID,
            error,
        );
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};

const normalizeArtists = (raw: Record<string, unknown>): Array<{ id: string | number; name: string }> => {
    const list = raw.artists ?? raw.artist ?? raw.singers ?? raw.singer;
    const fromList = Array.isArray(list)
        ? list.flatMap((entry, index) => {
            if (typeof entry === 'string') return entry.trim() ? [{ id: index, name: entry.trim() }] : [];
            const record = asRecord(entry);
            const name = firstString(record?.name, record?.title);
            return name ? [{ id: asString(record?.id) || index, name }] : [];
        })
        : [];
    if (fromList.length > 0) return fromList;
    // `artist: "A/B"`、`artist: "A、B"` 这类合写：按常见分隔符拆开。
    const text = firstString(list);
    if (!text) return [];
    return text.split(/\s*[/、,，&]\s*/).map((name, index) => ({ id: index, name })).filter(artist => artist.name);
};

const normalizeDurationMs = (raw: Record<string, unknown>): number => {
    const value = Number(raw.durationMs ?? raw.interval ?? raw.duration ?? raw.dt ?? 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    // 小于 1000 的多半是秒（一首歌不可能 300 毫秒），大于等于 1000 的按毫秒认。
    return Math.round(value >= 1000 ? value : value * 1000);
};

/** 一条音源回答里的歌 → 内部 UnifiedSong。字段名照常见写法都认一遍。 */
export const normalizeCustomSong = (raw: unknown): UnifiedSong => {
    const record = asRecord(raw);
    if (!record) {
        throw new OnlineProviderError('invalid-response', '自定义音源返回的歌曲不是对象', CUSTOM_SOURCE_ID);
    }
    const mediaId = firstString(record.id, record.songId, record.songid, record.mid, record.hash);
    if (!mediaId) {
        throw new OnlineProviderError('invalid-response', '自定义音源返回的歌曲没有 id', CUSTOM_SOURCE_ID);
    }
    const albumRecord = asRecord(record.album) ?? asRecord(record.al);
    const albumName = firstString(record.albumName, record.albumname, albumRecord?.name, record.album);
    const coverUrl = firstString(
        record.cover,
        record.coverUrl,
        record.pic,
        record.picUrl,
        albumRecord?.coverUrl,
        albumRecord?.picUrl,
    );
    return {
        id: mediaId,
        name: firstString(record.name, record.title, record.songName, record.songname) || 'Unknown Song',
        artists: normalizeArtists(record),
        album: {
            id: firstString(record.albumId, albumRecord?.id) || `${mediaId}#album`,
            name: albumName,
            ...(coverUrl ? { coverUrl } : {}),
        },
        durationMs: normalizeDurationMs(record),
        sourceRef: { kind: 'online', providerId: CUSTOM_SOURCE_ID, mediaId },
    };
};

export interface CustomSearchAnswer {
    items: UnifiedSong[];
    total?: number;
    hasMore: boolean;
}

export const searchCustomSongs = async (
    query: string,
    limit: number,
    offset: number,
    config: CustomSourceConfig = readCustomSourceConfig(),
): Promise<CustomSearchAnswer> => {
    if (!query.trim()) return { items: [], hasMore: false };
    const { status, body } = await requestJson(config, '/search', {
        keyword: query.trim(),
        limit,
        offset,
    });
    if (status >= 400) {
        throw new OnlineProviderError(
            'unavailable',
            `自定义音源搜索失败：HTTP ${status}`,
            CUSTOM_SOURCE_ID,
            body,
            status,
        );
    }
    const items = pickArray(body).flatMap(entry => {
        try {
            return [normalizeCustomSong(entry)];
        } catch {
            // 一条坏数据不该让整页搜索失败：跳过它。
            return [];
        }
    });
    const record = asRecord(body);
    const total = Number(record?.total);
    return {
        items,
        ...(Number.isFinite(total) && total >= 0 ? { total } : {}),
        hasMore: Boolean(record?.hasMore) || items.length >= limit,
    };
};

/** 一首歌的详情（可选端点）：服务没有 `/song` 就回 null，界面上仍是能搜能播的源。 */
export const fetchCustomSong = async (
    mediaId: string,
    config: CustomSourceConfig = readCustomSourceConfig(),
): Promise<UnifiedSong | null> => {
    const { status, body } = await requestJson(config, '/song', { id: mediaId });
    if (status >= 400) return null;
    const record = asRecord(body);
    const data = asRecord(record?.data) ?? record;
    const song = asRecord(data?.song) ?? data;
    if (!song) return null;
    try {
        return normalizeCustomSong(song);
    } catch {
        return null;
    }
};

/** 一首歌的可播地址；服务明确说没有（404 / 空 url）时回 null，其余失败抛错。 */
export const fetchCustomAudioSource = async (
    mediaId: string,
    quality: AudioQualityPreference,
    extra: { title?: string; artist?: string; album?: string; durationMs?: number } = {},
    config: CustomSourceConfig = readCustomSourceConfig(),
): Promise<ProviderAudioSource | null> => {
    const { status, body } = await requestJson(config, '/url', {
        id: mediaId,
        quality,
        title: extra.title,
        artist: extra.artist,
        album: extra.album,
        duration: extra.durationMs,
    });
    if (status === 404) return null;
    if (status >= 400) {
        throw new OnlineProviderError(
            'unavailable',
            `自定义音源取地址失败：HTTP ${status}`,
            CUSTOM_SOURCE_ID,
            body,
            status,
        );
    }
    const record = asRecord(body);
    const data = asRecord(record?.data) ?? record;
    const rawUrl = firstString(data?.url, data?.playUrl, data?.src, record?.url);
    const url = toSafePlaybackUrl(rawUrl);
    if (!url) return null;
    const expiresAt = Number(data?.expiresAt ?? record?.expiresAt);
    const preview = data?.preview === true || record?.preview === true;
    const servedQuality = firstString(data?.quality, record?.quality);
    const levels: AudioQualityPreference[] = ['standard', 'high', 'ultra', 'lossless', 'hires'];
    const declared = levels.includes(servedQuality as AudioQualityPreference)
        ? servedQuality as AudioQualityPreference
        : null;
    // 4-严格（契约校验）：服务**自己声明**的这一档比请求的档低，就是它没有按合同办。
    // 静默收下等于把这个文件按「请求的档」记进缓存（omni 记的是请求档或 source.quality），
    // 用户之后选的每一档都在听同一份更差的文件，且再也不会向这个源要一次。
    // 宁可让这一首失败 —— 它自己的上层（内置源/播放层）会照原来的样子报错或试听，而不是留一份错档的副本。
    // 只看服务说了什么：不声明 `quality` 的服务无法分辨真假，仍按「请求的档」交付（已知缺口）。
    // 试听片段（`preview: true`）不在此列：它本来就低一档，且从不会被当成整首缓存。
    if (!preview && declared && levels.indexOf(declared) < levels.indexOf(quality)) {
        throw new OnlineProviderError(
            'invalid-response',
            `自定义音源对 ${quality} 的请求给回了 ${declared}`,
            CUSTOM_SOURCE_ID,
            body,
        );
    }
    return {
        url,
        fetchedAt: Date.now(),
        ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
        quality: declared ?? quality,
        ...(preview ? { preview: true } : {}),
    };
};

/** 歌词（可选能力）：没有就回空字符串，由 provider 决定怎么答。 */
export const fetchCustomLyrics = async (
    mediaId: string,
    config: CustomSourceConfig = readCustomSourceConfig(),
): Promise<{ lrc: string; translated: string }> => {
    const { status, body } = await requestJson(config, '/lyric', { id: mediaId });
    if (status >= 400) return { lrc: '', translated: '' };
    const record = asRecord(body);
    const data = asRecord(record?.data) ?? record;
    return {
        lrc: firstString(data?.lrc, data?.lyric, data?.text, record?.lrc),
        translated: firstString(data?.translated, data?.trans, data?.tlyric),
    };
};
