import type { SongResult, UnifiedSong } from '../../types';
import type { AudioQualityPreference, OnlineMusicProvider, ProviderAudioSource, ProviderPage } from '../../types/onlineMusic';
import { getOnlineMusicProvider, getOnlineMusicProviderForSong, listOnlineMusicProviders, providerSupports } from '../onlineMusic/providerRegistry';
import { omni } from '../onlineMusic/omni';
import { looksLikeClip, probeAudioDurationMs } from '../onlineMusic/audioProbe';
import { scoreSongMatch } from '../onlineMusic/routing/lockedSongRouting';
import { isDifferentVersion } from '../onlineMusic/songVersionMatch';
import { getProviderSongMetadata } from '../onlineMusic/songMetadata';

// src/services/downloads/fullSource.ts
//
// 下载用的取址：要的是**完整版**，不是播放器为了先出声而接受的那一条。
//
// 播放可以接受试听片段（`preview`），下载不行——存一个 30 秒的文件没有意义。所以这里按顺序试：
//   1. 这首歌自己的源；
//   2. 其它能搜索的源——按「标题 + 歌手」搜一次，够像才取它的地址；
//   3. 星海（不搜索，按原平台 id 换地址）。
// 任何一步拿到「有地址且不是片段」的就返回；全都只有片段才放弃。
//
// 跨源匹配用的是 lockedSongRouting 的 scoreSongMatch 与同一个阈值：下载和播放兜底对「像不像」
// 的判断必须一致，否则会出现「播放换到了 B 版，下载却是 A 版」。

const MATCH_THRESHOLD = 85;
/** 最多试几个源。搜索是网络请求，不能让一次下载把每个源都轮一遍。 */
const MAX_SEARCH_CANDIDATES = 4;

export type FullAudioSource = {
    source: ProviderAudioSource;
    /** 实际给出地址的源；和自己的源不同时，说明换了源。 */
    providerId: string;
};

const tryProvider = async (
    provider: OnlineMusicProvider,
    target: SongResult,
    quality: AudioQualityPreference,
    expectedMs: number,
): Promise<ProviderAudioSource | null> => {
    if (!provider.playback?.getAudioSource) return null;
    try {
        const level = omni.resolveAudioQuality(provider.id, quality);
        const source = await provider.playback.getAudioSource(target, level);
        if (!source?.url || source.preview) return null;
        // 下载必须是整首：平台没标 preview 也可能给的是一条 30 秒地址（会员歌常见），
        // 所以这里实测一次时长，明显短于歌曲就换下一个源。
        const actualMs = await probeAudioDurationMs(source.url);
        if (looksLikeClip(actualMs, expectedMs)) return null;
        return source;
    } catch {
        return null;
    }
};

const artistOf = (song: SongResult): string => (
    getProviderSongMetadata(song).artists.map(artist => artist.name).filter(Boolean).join(' ')
);

export { isDifferentVersion } from '../onlineMusic/songVersionMatch';

export const resolveFullAudioSource = async (
    song: SongResult,
    quality: AudioQualityPreference,
): Promise<FullAudioSource | null> => {
    const own = getOnlineMusicProviderForSong(song);
    if (own) {
        const source = await tryProvider(own, song, quality, song.durationMs);
        if (source) return { source, providerId: own.id };
    }

    // 先按「原平台 id」换地址的源（星海）：id 唯一对应用户听的这首歌，不会串到现场版/翻唱版。
    // 播放时走的就是这条，所以下载拿到的与听到的是同一个录音。
    for (const providerId of ['xinghai'] as const) {
        const provider = getOnlineMusicProvider(providerId);
        if (!provider) continue;
        if (provider.getAvailability?.().configured === false) continue;
        const source = await tryProvider(provider, song, quality, song.durationMs);
        if (source) return { source, providerId };
    }

    // 搜索型源：跳过自己、跳过没有 playback/search 的、跳过明确不可用的。
    const query = [song.name, artistOf(song)].filter(Boolean).join(' ').trim();
    const candidates = listOnlineMusicProviders()
        .filter(provider => provider.id !== own?.id)
        .filter(provider => providerSupports(provider, 'search') && provider.search)
        .filter(provider => providerSupports(provider, 'playback') && provider.playback)
        .filter(provider => provider.getAvailability?.().configured !== false)
        // 不需要登录的先试：酷我在列表里排前面，它的地址也最稳定。
        .sort((a, b) => Number(Boolean(a.capabilities.auth)) - Number(Boolean(b.capabilities.auth)))
        .slice(0, MAX_SEARCH_CANDIDATES);

    if (query) {
        for (const provider of candidates) {
            let page: ProviderPage<UnifiedSong> | null = null;
            try {
                page = await provider.search!.searchSongs(query, 10, 0);
            } catch {
                continue;
            }
            let best: SongResult | null = null;
            let bestScore = 0;
            for (const candidate of page.items) {
                // 同名不同版本（现场/晚会/翻唱）在评分上几乎与原版持平，直接排除。
                if (isDifferentVersion(song.name, candidate.name)) continue;
                const score = scoreSongMatch(song, candidate);
                if (score > bestScore) {
                    best = candidate;
                    bestScore = score;
                }
            }
            if (!best || bestScore < MATCH_THRESHOLD) continue;
            const source = await tryProvider(provider, best, quality, song.durationMs);
            if (source) return { source, providerId: provider.id };
        }
    }

    return null;
};
