import type {
    OnlineFailureDetail,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderSongAvailability,
} from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { SongResult } from '../../../types';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../../utils/lyrics/pureMusic';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import {
    CUSTOM_SOURCE_ID,
    isCustomSourceConfigured,
    readCustomSourceConfig,
} from './customSourceConfig';
import {
    fetchCustomAudioSource,
    fetchCustomLyrics,
    fetchCustomSong,
    normalizeCustomSong,
    searchCustomSongs,
} from './customSourceClient';
import type { CustomSourceConfig } from './customSourceConfig';

// src/services/onlineMusic/custom/customProvider.ts
//
// 自定义音源：一个能搜、能给播放地址的 HTTP 服务，接成正常的 Omni provider。
//
// 它没有账号（`auth: false`，界面上是「无需登录」），因此不参与账号读、歌单、红心、上报；
// 只做三件事：搜歌、给地址、可选给歌词。歌曲 id 用服务自己的 id，落在
// `sourceRef = { kind: 'online', providerId: 'custom', mediaId }` 上——这个 providerId 就是它的
// 唯一 sourceRef，队列、历史、缓存键（online:custom:<id>）都靠它和别的源分开。
//
// 合同见 customSourceClient.ts 的文件头。没有配地址时 `getAvailability()` 是 not-configured，
// 界面上这个源不可用；这不影响内置源。

const providerConfig = (): CustomSourceConfig => readCustomSourceConfig();

const sourceOf = (song: SongResult) => {
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' && ref.providerId === CUSTOM_SOURCE_ID ? ref : null;
};

const notConfigured = (): OnlineProviderError => new OnlineProviderError(
    'unavailable',
    '自定义音源没有配置地址：设置 VITE_CUSTOM_SOURCE_BASE，或写 localStorage 的 folia.customSource.v1',
    CUSTOM_SOURCE_ID,
);

// 音源自己说的地址可能就是整首之外的片段（试听），`preview` 由服务声明，照传给上层：
// 播放时会带提示，且不会被当成整首缓存。
const describeFailure = (error: unknown): OnlineFailureDetail | null => {
    if (!(error instanceof OnlineProviderError)) return null;
    if (error.code === 'network') return { case: 'unreachable' };
    if (error.code === 'not-playable') return { case: 'no-audio' };
    if (error.code === 'unavailable' && !isCustomSourceConfigured()) return { case: 'not-configured' };
    return null;
};

export const customProvider: OnlineMusicProvider = {
    id: CUSTOM_SOURCE_ID,
    displayName: '自定义音源',
    shortName: '自定义',
    mark: { letter: '自', color: '#7c3aed' },
    getAvailability: () => (
        isCustomSourceConfigured()
            ? { configured: true }
            : { configured: false, reason: 'not-configured' as const }
    ),
    describeFailure: (_operation, error) => describeFailure(error),
    capabilities: {
        search: true,
        playback: true,
        // 歌词是可选端点：服务没有 /lyric 时按「没有歌词」处理，不当成能力的缺失。
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
    normalizeSong: raw => normalizeCustomSong(raw),
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    search: {
        async searchSongs(query, limit, offset) {
            const config = providerConfig();
            if (!config.enabled) throw notConfigured();
            const answer = await searchCustomSongs(query, limit, offset, config);
            return {
                items: answer.items,
                ...(answer.total !== undefined ? { total: answer.total } : {}),
                hasMore: answer.hasMore,
                nextOffset: offset + answer.items.length,
            };
        },
    },

    playback: {
        // 两档；为什么、代价是什么，见同目录 README 的「档位」一节。
        audioQualityLevels: ['standard', 'high'],

        async getSongDetail(id) {
            const config = providerConfig();
            if (!config.enabled) return null;
            return await fetchCustomSong(String(id), config);
        },

        async getAudioSource(song, quality): Promise<ProviderAudioSource | null> {
            const ref = sourceOf(song);
            if (!ref) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to the custom source', CUSTOM_SOURCE_ID);
            }
            const config = providerConfig();
            if (!config.enabled) throw notConfigured();
            return await fetchCustomAudioSource(String(ref.mediaId), quality, {
                title: song.name,
                artist: (song.artists ?? []).map(artist => artist.name).filter(Boolean).join(', '),
                album: song.album?.name,
                durationMs: song.durationMs,
            }, config);
        },

        // 这个源从不下架也从不「受限」：有没有地址由取地址的那一刻说了算。
        getAvailability(_song): ProviderSongAvailability {
            return { state: 'unknown' };
        },
    },

    lyrics: {
        async getLyrics(song) {
            const ref = sourceOf(song);
            if (!ref) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to the custom source', CUSTOM_SOURCE_ID);
            }
            const config = providerConfig();
            if (!config.enabled) return { lyrics: null, isPureMusic: false };
            const { lrc, translated } = await fetchCustomLyrics(String(ref.mediaId), config);
            if (!lrc) return { lyrics: null, isPureMusic: false };
            const parsed = parseLyricsByFormat('lrc', lrc, translated);
            return {
                lyrics: parsed.lines.length > 0 ? parsed : null,
                mainText: lrc,
                translationText: translated || null,
                isPureMusic: isPureMusicLyricText(lrc),
            };
        },
    },
};

/** 这首歌是不是本源的。给路由层与测试用，免得它们各自拼一遍 sourceRef。 */
export const isCustomSourceSong = (song: SongResult): boolean => sourceOf(song) !== null;
