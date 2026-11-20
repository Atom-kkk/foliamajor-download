import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';

// test/unit/onlineMusic/lockedSongRoutingAccountFallback.test.ts
// 跨平台兜底：星海只能换免费音频。目标平台自己有账号登录着时，应该再用该平台自己的
// 取址问一次；没有登录（或只有游客）时不能问。

const mocks = vi.hoisted(() => ({
    xinghaiAudio: vi.fn(),
    neteaseAudio: vi.fn(),
    neteaseSearch: vi.fn(),
}));

vi.mock('@/services/onlineMusic/providerRegistry', () => {
    const qishui = {
        id: 'qishui',
        capabilities: { playback: true },
        playback: { getAvailability: () => ({ state: 'playable' }) },
    };
    const xinghai = {
        id: 'xinghai',
        capabilities: { playback: true },
        playback: { getAudioSource: mocks.xinghaiAudio },
    };
    const netease = {
        id: 'netease',
        capabilities: { search: true, playback: true },
        getAvailability: () => ({ configured: true }),
        search: { searchSongs: mocks.neteaseSearch },
        playback: { getAudioSource: mocks.neteaseAudio },
    };
    return {
        getOnlineMusicProvider: (id: string) => ({ xinghai, netease } as Record<string, unknown>)[id] ?? null,
        getOnlineMusicProviderForSong: () => qishui,
        providerSupports: (provider: { capabilities?: Record<string, boolean> }, key: string) => Boolean(provider.capabilities?.[key]),
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

import { resolveLockedSongAudio } from '@/services/onlineMusic/routing/lockedSongRouting';

const song = {
    id: '7451778868879214609',
    name: '天亮以前说再见（雪花多舍不得冬天）',
    artists: [{ id: '1', name: '徐化文' }],
    album: { id: '1', name: '天亮以前说再见' },
    durationMs: 233_000,
    fee: 1,
    privilege: { payed: 0, pl: 0 },
    sourceRef: { kind: 'online' as const, providerId: 'qishui' as const, mediaId: '7451778868879214609' },
};

const neteaseCandidate = {
    id: '2659565914',
    name: '天亮以前说再见（雪花多舍不得冬天）',
    artists: [{ id: '2', name: '徐化文' }],
    album: { id: '2', name: '天亮以前说再见' },
    durationMs: 233_000,
    sourceRef: { kind: 'online' as const, providerId: 'netease' as const, mediaId: '2659565914' },
};

const signIn = (providerId: string, userId = 'u1', vipType = 1) => useOnlineProviderAccountStore.setState({
    accounts: {
        [providerId]: {
            status: 'authenticated',
            user: { id: userId, nickname: 'me', avatarUrl: '', vipType },
            collections: [],
            likedSongIds: [],
            wantedLikes: {},
            hydration: 'ready',
            freshness: 'fresh',
        },
    } as never,
});

beforeEach(() => {
    vi.clearAllMocks();
    useOnlineProviderAccountStore.setState({ accounts: {} });
    mocks.xinghaiAudio.mockRejectedValue(new Error('星海音源：未找到该歌曲'));
    mocks.neteaseSearch.mockResolvedValue({ items: [neteaseCandidate], total: 1, hasMore: false });
    mocks.neteaseAudio.mockResolvedValue({ url: 'https://cdn.example/song.mp3', quality: 'high' });
});

describe('cross-platform fallback with a signed-in target platform', () => {
    it('asks the target platform itself when Xinghai cannot fetch the id', async () => {
        signIn('netease');

        const source = await resolveLockedSongAudio(song as never, 'high', { force: true });

        expect(source?.url).toBe('https://cdn.example/song.mp3');
        expect(mocks.neteaseAudio).toHaveBeenCalledTimes(1);
    });

    it('does not ask a platform nobody is signed in to', async () => {
        const source = await resolveLockedSongAudio(song as never, 'high', { force: true });

        expect(source).toBeNull();
        expect(mocks.neteaseAudio).not.toHaveBeenCalled();
    });

    it('treats a guest session as nobody', async () => {
        signIn('netease', 'guest', 0);

        const source = await resolveLockedSongAudio(song as never, 'high', { force: true });

        expect(source).toBeNull();
        expect(mocks.neteaseAudio).not.toHaveBeenCalled();
    });

    it('falls through when the account itself only gets a preview', async () => {
        signIn('netease');
        mocks.neteaseAudio.mockResolvedValue({ url: 'https://cdn.example/clip.mp3', quality: 'high', preview: true });

        const source = await resolveLockedSongAudio(song as never, 'high', { force: true });

        expect(source).toBeNull();
        expect(mocks.neteaseAudio).toHaveBeenCalled();
    });

    it('keeps the free swap when it does give a full address', async () => {
        signIn('netease');
        // 按原歌（汽水）的 id 只换到试听；按网易云那条的 id 才换到完整文件。
        mocks.xinghaiAudio.mockImplementation(async (target: { id: string }) => (
            target.id === neteaseCandidate.id
                ? { url: 'https://cdn.example/xinghai.mp3', quality: 'high' }
                : { url: 'https://cdn.example/clip.mp3', quality: 'high', preview: true }
        ));

        const source = await resolveLockedSongAudio(song as never, 'high', { force: true });

        expect(source?.url).toBe('https://cdn.example/xinghai.mp3');
        expect(mocks.neteaseAudio).not.toHaveBeenCalled();
    });
});
