import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/lockedSongRoutingSwapBackends.test.ts
// 兜底链里的两个换址后端：星海只给免费音频，拿不到时该轮到聚合音源（会员曲只有它给）。
// 两个都要能出现在「直接按 id 换址」和「跨平台搜到原版再换址」这两条路上。

const mocks = vi.hoisted(() => ({
    xinghaiAudio: vi.fn(),
    animemusicAudio: vi.fn(),
    neteaseSearch: vi.fn(),
}));

vi.mock('@/services/onlineMusic/providerRegistry', () => {
    // 工厂被提升到文件顶部，这里不能引用外面的变量。
    const provider = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        capabilities: { playback: true },
        getAvailability: () => ({ configured: true }),
        playback: { getAudioSource: vi.fn() },
        ...extra,
    });
    const custom = { ...provider('custom'), getAvailability: () => ({ configured: false }) };
    const xinghai = provider('xinghai', { playback: { getAudioSource: mocks.xinghaiAudio } });
    const animemusic = provider('animemusic', { playback: { getAudioSource: mocks.animemusicAudio } });
    const kuwo = provider('kuwo');
    const qishui = provider('qishui');
    const netease = {
        ...provider('netease'),
        capabilities: { search: true, playback: true },
        search: { searchSongs: mocks.neteaseSearch },
    };
    const all: Record<string, unknown> = { custom, xinghai, animemusic, kuwo, qishui, netease };
    return {
        getOnlineMusicProvider: (id: string) => all[id] ?? null,
        getOnlineMusicProviderForSong: (song: { sourceRef?: { providerId?: string } }) => (
            all[String(song?.sourceRef?.providerId)] ?? null
        ),
        providerSupports: (given: { capabilities?: Record<string, boolean> } | null, key: string) => Boolean(given?.capabilities?.[key]),
        listOnlineMusicProviders: () => Object.values(all),
    };
});

vi.mock('@/services/onlineMusic/custom/customSourceConfig', () => ({
    isLockedSongRoutingEnabled: () => true,
    lockedSongFallbackProviderId: () => 'custom',
}));

vi.mock('@/services/onlineMusic/audioProbe', () => ({
    isClipAudio: async () => false,
    looksLikeClip: () => false,
    probeAudioDurationMs: async () => null,
}));

vi.mock('@/services/onlineMusic/routing/webArchive', () => ({
    isWebArchiveAvailable: () => false,
    fetchWebArchiveAudio: async () => null,
    searchWebArchive: async () => [],
}));

import { forgetLockedSongMappings, resolveLockedSongAudio } from '@/services/onlineMusic/routing/lockedSongRouting';

const lockedSongOn = (providerId: string, mediaId: string) => ({
    id: mediaId,
    name: '天亮以前说再见',
    artists: [{ id: '1', name: '徐化文' }],
    album: { id: '1', name: '天亮以前说再见' },
    durationMs: 233_000,
    fee: 1,
    privilege: { payed: 0, pl: 0 },
    sourceRef: { kind: 'online' as const, providerId, mediaId },
});

describe('locked song fallback · the two swap backends', () => {
    beforeEach(() => {
        forgetLockedSongMappings();
        mocks.xinghaiAudio.mockReset();
        mocks.animemusicAudio.mockReset();
        mocks.neteaseSearch.mockReset();
    });

    it('asks the aggregate source when the free swap has nothing for this id', async () => {
        mocks.xinghaiAudio.mockRejectedValue(new Error('星海音源：未找到该歌曲'));
        mocks.animemusicAudio.mockResolvedValue({ url: 'https://cdn/anime.flac', quality: 'lossless', fetchedAt: 1 });

        const source = await resolveLockedSongAudio(lockedSongOn('qq', '002pk70j0rkJOE'), 'lossless');

        expect(mocks.xinghaiAudio).toHaveBeenCalledTimes(1);
        expect(mocks.animemusicAudio).toHaveBeenCalledTimes(1);
        expect(source?.url).toBe('https://cdn/anime.flac');
    });

    it('keeps the free swap first, and does not ask the aggregate source when it worked', async () => {
        mocks.xinghaiAudio.mockResolvedValue({ url: 'https://cdn/free.mp3', quality: 'high', fetchedAt: 1 });

        const source = await resolveLockedSongAudio(lockedSongOn('qq', '002pk70j0rkJOE'), 'standard');

        expect(source?.url).toBe('https://cdn/free.mp3');
        expect(mocks.animemusicAudio).not.toHaveBeenCalled();
    });

    it('swaps a song found on another platform, since that id is not the one the song came with', async () => {
        // 本平台的 id 谁都换不出来（汽水的会员曲就是这样）；网易云搜到原版后，聚合音源能换。
        mocks.xinghaiAudio.mockRejectedValue(new Error('星海音源：未找到该歌曲'));
        mocks.animemusicAudio.mockImplementation(async (song: { sourceRef?: { providerId?: string } }) => {
            if (song?.sourceRef?.providerId !== 'netease') throw new Error('聚合音源：获取URL失败');
            return { url: 'https://cdn/wy.flac', quality: 'lossless', fetchedAt: 1 };
        });
        mocks.neteaseSearch.mockResolvedValue({
            items: [{
                id: '2659565914',
                name: '天亮以前说再见',
                artists: [{ id: '2', name: '徐化文' }],
                album: { id: '2', name: '天亮以前说再见' },
                durationMs: 233_000,
                sourceRef: { kind: 'online', providerId: 'netease', mediaId: '2659565914' },
            }],
            total: 1,
        });

        const source = await resolveLockedSongAudio(lockedSongOn('qishui', '7451778868879214609'), 'lossless');

        expect(mocks.neteaseSearch).toHaveBeenCalled();
        expect(source?.url).toBe('https://cdn/wy.flac');
    });
});
