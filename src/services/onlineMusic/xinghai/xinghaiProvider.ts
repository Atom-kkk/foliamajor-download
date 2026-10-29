import type { OnlineMusicProvider, ProviderAudioSource, ProviderSongAvailability } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { toSafePlaybackUrl } from '../../../utils/appPlaybackHelpers';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import { XINGHAI_SOURCE_ID, fetchXinghaiAudio, isXinghaiAvailable, xinghaiPlatformOf, type XinghaiPlatform } from './xinghai';

// src/services/onlineMusic/xinghai/xinghaiProvider.ts
//
// 星海音源：按「原来那首歌在自己的平台上的 id」向后端换一条地址。它没有搜索接口，所以不是第二个
// 搜索源，而是内置源放不出来时的兜底（lockedSongRouting 会优先用它，见 routing/lockedSongRouting.ts）。
//
// 覆盖：两个 mediaId 能直接当后端 id 用的平台。酷我由 kuwo/ 的直连源负责；另一个需要
// 数字 id + hash 两样的平台不在这里重复。
//
// 只在桌面端可用（自定义头触发预检，必须经主进程，见 electron/xinghai/xinghaiIpc.cjs）。

const platformOfSong = (song: SongResult): XinghaiPlatform | null => {
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' ? xinghaiPlatformOf(ref.providerId) : null;
};

export const xinghaiProvider: OnlineMusicProvider = {
    id: XINGHAI_SOURCE_ID,
    displayName: '星海音源',
    shortName: '星海',
    mark: { letter: '星', color: '#6366f1' },
    getAvailability: () => (isXinghaiAvailable()
        ? { configured: true }
        : { configured: false, reason: 'runtime-unavailable' }),
    capabilities: {
        // 没有搜索：后端只换地址，不搜歌。
        search: false,
        playback: true,
        // 后端回 `lrc` 的格式没有保证，先不声明歌词能力，免得用一份读不出来的词盖掉内置源的词。
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
        const song = raw as UnifiedSong;
        if (song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === XINGHAI_SOURCE_ID) return song;
        throw new OnlineProviderError('invalid-response', '星海音源不产生歌曲，只换地址', XINGHAI_SOURCE_ID);
    },
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    playback: {
        async getSongDetail() {
            return null;
        },

        async getAudioSource(song, quality): Promise<ProviderAudioSource> {
            if (!platformOfSong(song)) {
                throw new OnlineProviderError(
                    'unsupported',
                    '星海音源只接 mediaId 能直接当后端 id 的平台',
                    XINGHAI_SOURCE_ID,
                );
            }
            const ref = getPlaybackSourceRef(song);
            if (ref.kind !== 'online') {
                throw new OnlineProviderError('unsupported', 'Song is not from an online provider', XINGHAI_SOURCE_ID);
            }
            const meta = createProviderSongMetadata(song);
            const audio = await fetchXinghaiAudio({
                providerId: ref.providerId,
                mediaId: String(ref.mediaId),
                name: song.name,
                singer: meta.artists.map(artist => artist.name).filter(Boolean).join(' '),
                albumName: meta.album?.name,
                ...(meta.durationMs > 0 ? { interval: meta.durationMs / 1000 } : {}),
            }, quality);
            return {
                url: toSafePlaybackUrl(audio.url) ?? audio.url,
                fetchedAt: Date.now(),
                // 按它实际给的档记：请求 320k 却回 128k 时，缓存不会被标成 320k。
                quality: audio.quality,
            };
        },
        // 两档：后端对 flac 的回应不稳定，声明无损只会让缓存把低档记成无损。
        audioQualityLevels: ['standard', 'high'],
        getAvailability(_song): ProviderSongAvailability {
            return { state: 'unknown' };
        },
    },
};
