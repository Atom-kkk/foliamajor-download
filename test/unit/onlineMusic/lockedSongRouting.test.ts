import { describe, expect, it } from 'vitest';
import { scoreSongMatch, simplifiedSubject } from '@/services/onlineMusic/routing/lockedSongRouting';

// test/unit/onlineMusic/lockedSongRouting.test.ts
// 兜底匹配的字形问题：Spotify 的曲目名是繁体（「說好的幸福呢」），网易云、酷我的曲库是简体。
// 2026-11-14 的日志里，第四步搜到了东西但 `bestScore: 0` —— 标题不做繁简归一化，整条兜底链作废。

const spotifySong = {
    id: '4OoExItZJ0jePoCZDbHx4t',
    name: '說好的幸福呢',
    artists: [{ id: '6452', name: '周杰倫' }],
    album: { id: '1', name: '魔杰座' },
    durationMs: 256_000,
    sourceRef: { kind: 'online' as const, providerId: 'spotify' as const, mediaId: '4OoExItZJ0jePoCZDbHx4t' },
};

const neteaseCandidate = {
    id: '1',
    name: '说好的幸福呢',
    artists: [{ id: '6452', name: '周杰伦' }],
    album: { id: '1', name: '魔杰座' },
    durationMs: 256_000,
    sourceRef: { kind: 'online' as const, providerId: 'netease' as const, mediaId: '1' },
};

describe('fallback matching across character sets', () => {
    it('scores nothing for the traditional title against the simplified one', () => {
        // 这就是旧行为：标题对不上，分数是 0，候选全被丢掉。
        expect(scoreSongMatch(spotifySong as never, neteaseCandidate as never)).toBe(0);
    });

    it('turns the search subject into simplified text', async () => {
        const subject = await simplifiedSubject(spotifySong as never);
        expect(subject.name).toBe('说好的幸福呢');
        expect(subject.artists?.[0]?.name).toBe('周杰伦');
        // 其余字段不动：媒体 id、来源都还要照原样用。
        expect(subject.sourceRef).toEqual(spotifySong.sourceRef);
        expect(subject.durationMs).toBe(spotifySong.durationMs);
    });

    it('matches the netease candidate once the subject is simplified', async () => {
        const subject = await simplifiedSubject(spotifySong as never);
        expect(scoreSongMatch(subject, neteaseCandidate as never)).toBeGreaterThanOrEqual(85);
    });
});
