import type { OnlineMusicProvider, ProviderAudioSource, ProviderSongAvailability } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { toSafePlaybackUrl } from '../../../utils/appPlaybackHelpers';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import {
    ANIMEMUSIC_SOURCE_ID,
    animemusicSourceOf,
    fetchAnimemusicAudio,
    isAnimemusicAvailable,
    type AnimemusicSource,
} from './animemusic';

// src/services/onlineMusic/animemusic/animemusicProvider.ts
//
// 聚合音源：按「原来那首歌在自己的平台上的 id」向后端换一条地址。没有搜索接口，所以不是第二个
// 搜索源，而是内置源放不出来时的兜底候选（见 routing/lockedSongRouting.ts）。
//
// 它和星海是同一类东西，区别在于能给什么：
//   - 星海只免费换址，会员曲（网易云 / QQ 的 `fee=1`）拿不到；
//   - 这一个后端不管免费/付费，网易云、酷狗的会员曲会给完整文件——2026-11-21 实测网易云
//     《天亮以前说再见》拿到 3.73 MB mp3 与 24.7 MB flac，都与 233 s 的歌长吻合。
// 所以它排在星海**之后**、酷我搜索**之前**：星海先试（一次 GET，最快），它再补上会员曲那一档。
//
// 只能桌面端用：后端不放行浏览器侧的预检，请求走主进程窄代理（electron/animemusic/animemusicIpc.cjs）。

const sourceOfSong = (song: SongResult): AnimemusicSource | null => {
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' ? animemusicSourceOf(ref.providerId) : null;
};

export const animemusicProvider: OnlineMusicProvider = {
    id: ANIMEMUSIC_SOURCE_ID,
    displayName: '聚合音源',
    shortName: '聚合',
    shortNameKey: 'onlineProviderName.animemusic',
    mark: { letter: '聚', color: '#0ea5e9' },
    getAvailability: () => (isAnimemusicAvailable()
        ? { configured: true }
        : { configured: false, reason: 'runtime-unavailable' }),
    capabilities: {
        // 没有搜索：后端换地址，不搜歌。
        search: false,
        playback: true,
        // 后端不回歌词，声明了就只会用一份读不出来的词盖掉内置源的词。
        lyrics: false,
        auth: false,
        userLibrary: false,
        playlists: false,
        albums: false,
        artists: false,
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
    },
    // 本源不产生歌曲（不搜索），所以没有可归一化的输入。
    normalizeSong: (raw: unknown): UnifiedSong => {
        const song = raw as UnifiedSong | undefined;
        if (song && song.sourceRef.kind === 'online' && song.sourceRef.providerId === ANIMEMUSIC_SOURCE_ID) return song;
        throw new OnlineProviderError('invalid-response', '聚合音源不产生歌曲，只换地址', ANIMEMUSIC_SOURCE_ID);
    },
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    playback: {
        getSongDetail: () => Promise.resolve(null),

        async getAudioSource(song, quality): Promise<ProviderAudioSource> {
            if (!sourceOfSong(song)) {
                throw new OnlineProviderError(
                    'unsupported',
                    '聚合音源不接这个平台',
                    ANIMEMUSIC_SOURCE_ID,
                );
            }
            const ref = getPlaybackSourceRef(song);
            if (ref.kind !== 'online') {
                throw new OnlineProviderError('unsupported', 'Song is not from an online provider', ANIMEMUSIC_SOURCE_ID);
            }
            const audio = await fetchAnimemusicAudio({
                providerId: ref.providerId,
                mediaId: ref.mediaId,
            }, quality);
            return {
                url: toSafePlaybackUrl(audio.url) ?? audio.url,
                fetchedAt: Date.now(),
                // 按地址实际是什么记：后端没有回报档位，mp3 记 standard/high，flac 记无损。
                quality: audio.quality,
            };
        },
        // 三档：standard / high / lossless。`hires` 不声明——后端不给「24 bit」的证据，
        // 声明了只会让缓存把 flac 记成 hires。
        audioQualityLevels: ['standard', 'high', 'lossless'],
        getAvailability(): ProviderSongAvailability {
            return { state: 'unknown' };
        },
    },
};
