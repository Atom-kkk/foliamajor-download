import type {
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderPage,
    ProviderSongAvailability,
} from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../../utils/lyrics/pureMusic';
import { toSafePlaybackUrl } from '../../../utils/appPlaybackHelpers';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import { KUWO_SOURCE_ID, fetchKuwoAudio, fetchKuwoLyric, isKuwoAvailable, searchKuwo } from './kuwo';

// src/services/onlineMusic/kuwo/kuwoProvider.ts
//
// 酷我音乐：搜索、取址、歌词。取址与歌词来自 LX 自定义源 `無名v0.0.3.js`（仓库
// xzh767/lxmusic-source-all）里「直连酷我」的那一段；搜索用的是酷我自己的老接口。
//
// 这个源不需要登录：酷我对未登录的请求照样给免费歌与一部分会员歌的地址（实测周杰伦《告白气球》
// 原版返回 320k）。因此它同时是一个可独立搜索的源，也是「会员歌改由第三方提供」的天然兜底。
//
// 只在桌面端可用：搜索端点没有 CORS 头，渲染层必须经主进程的窄代理（electron/kuwo/kuwoIpc.cjs）。

const sourceOf = (song: SongResult | null | undefined) => {
    if (!song) return null;
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' && ref.providerId === KUWO_SOURCE_ID ? ref : null;
};

const page = (items: UnifiedSong[], total: number, offset: number): ProviderPage<UnifiedSong> => ({
    items,
    total,
    hasMore: offset + items.length < total,
    nextOffset: offset + items.length,
});

export const kuwoProvider: OnlineMusicProvider = {
    id: KUWO_SOURCE_ID,
    displayName: '酷我音乐',
    shortName: '酷我',
    mark: { letter: '酷', color: '#f59e0b' },
    getAvailability: () => (isKuwoAvailable()
        ? { configured: true }
        : { configured: false, reason: 'runtime-unavailable' }),
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        auth: false,
        userLibrary: false,
        playlists: false,
        albums: false,
        artists: false,
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
    },
    normalizeSong: raw => {
        const song = raw as UnifiedSong;
        if (song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === KUWO_SOURCE_ID) return song;
        throw new OnlineProviderError('invalid-response', 'KuWo 的歌曲只能由本源归一化', KUWO_SOURCE_ID);
    },
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return page([], 0, offset);
            const answer = await searchKuwo(query.trim(), limit, offset);
            return page(answer.items, answer.total, offset);
        },
    },

    playback: {
        // 酷我没有一条「按 id 取详情」的公开接口（搜索接口只按关键词）。队列里存的是完整歌曲，
        // 所以这条只用于「只有 id」的恢复路径：那里拿不到详情，返回 null 比编一个空壳好。
        async getSongDetail() {
            return null;
        },

        async getAudioSource(song, quality): Promise<ProviderAudioSource> {
            const ref = sourceOf(song);
            if (!ref) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to KuWo', KUWO_SOURCE_ID);
            }
            // 只声明到 high（见下），所以传下去的也是这两档之一；酷我仍可能给更低的档，
            // 那时按它实际给的 bitrate 标，别把 128k 记成 320k。
            const audio = await fetchKuwoAudio(String(ref.mediaId), quality);
            const url = toSafePlaybackUrl(audio.url) ?? audio.url;
            return {
                url,
                fetchedAt: Date.now(),
                quality: audio.quality,
            };
        },
        // 两档：酷我对 2000kflac 的请求常常回 256k，声明 lossless 只会让缓存把低档记成无损。
        audioQualityLevels: ['standard', 'high'],
        // 这个源从不下架也从不「受限」：有没有地址由取地址那一刻说了算。
        getAvailability(_song): ProviderSongAvailability {
            return { state: 'unknown' };
        },
    },

    lyrics: {
        async getLyrics(song) {
            const ref = sourceOf(song);
            if (!ref) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to KuWo', KUWO_SOURCE_ID);
            }
            const { lrc } = await fetchKuwoLyric(String(ref.mediaId));
            if (!lrc.trim()) return { lyrics: null, isPureMusic: false };
            const parsed = parseLyricsByFormat('lrc', lrc);
            return {
                lyrics: parsed.lines.length > 0 ? parsed : null,
                mainText: lrc,
                translationText: null,
                isPureMusic: isPureMusicLyricText(lrc),
            };
        },
    },

    getSongPageUrl(song) {
        const ref = sourceOf(song);
        return ref ? `https://www.kuwo.cn/play_detail/${encodeURIComponent(String(ref.mediaId))}` : null;
    },
};

/** 这首歌是不是酷我的。给路由层与测试用。 */
export const isKuwoSong = (song: SongResult): boolean => sourceOf(song) !== null;
