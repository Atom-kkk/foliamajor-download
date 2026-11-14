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

// 另外两种对不上的常见情形（2026-11-14 第二份日志）：
// 1) 平台把副标题写进曲名：`有一種悲傷 - 電影《…》主題曲`，曲库里只有「有一种悲伤」。
// 2) 同一个艺人在两边署名不同：A-Lin / 黄丽玲。
describe('titles with a subtitle, and one artist under two names', () => {
    const spotifyWithSubtitle = {
        id: '3ayrHkyorPEpeOBvZ76SwG',
        name: '有一種悲傷 - 電影《比悲傷更悲傷的故事》主題曲',
        artists: [{ id: '1', name: 'A-Lin' }],
        album: { id: '1', name: '比悲傷更悲傷的故事' },
        durationMs: 237_000,
        sourceRef: { kind: 'online' as const, providerId: 'spotify' as const, mediaId: '3ayrHkyorPEpeOBvZ76SwG' },
    };
    const neteaseOriginal = {
        id: '1363920368',
        name: '有一种悲伤',
        artists: [{ id: '2', name: '黄丽玲' }],
        album: { id: '2', name: '比悲傷更悲傷的故事' },
        durationMs: 237_000,
        sourceRef: { kind: 'online' as const, providerId: 'netease' as const, mediaId: '1363920368' },
    };

    it('ignores the subtitle and accepts the same recording under another artist name', async () => {
        const subject = await simplifiedSubject(spotifyWithSubtitle as never);
        expect(subject.name).toContain('有一种悲伤');
        expect(scoreSongMatch(subject, neteaseOriginal as never)).toBeGreaterThanOrEqual(85);
    });

    it('still refuses a cover: same title, different length', async () => {
        const cover = { ...neteaseOriginal, durationMs: 233_000, artists: [{ id: '3', name: '马也_Crabbit' }] };
        const subject = await simplifiedSubject(spotifyWithSubtitle as never);
        expect(scoreSongMatch(subject, cover as never)).toBe(0);
    });
});

// 「妳」不在 opencc 的繁转简表里：`為妳寫的歌` → `为妳写的歌`，而曲库存的是 `为你写的歌`。
// 2026-11-15 的实测：酷狗对这两种查询返回同一批结果（第一条 `为你写的歌 / 方大同 / 197 s`），
// 但标题判据按字形比较，`为妳写的歌` 对 `为你写的歌` 给 0 分，整条兜底链因此失败。
describe('a title written with the feminine second person', () => {
    const spotify = {
        id: '5qmtIGToI36Z9sNE7bvghH',
        name: '為妳寫的歌',
        artists: [{ id: '1', name: '方大同' }],
        album: { id: '1', name: '橙月' },
        durationMs: 197_000,
        sourceRef: { kind: 'online' as const, providerId: 'spotify' as const, mediaId: '5qmtIGToI36Z9sNE7bvghH' },
    };
    const kugouHit = {
        id: 'dc8087e99400f25bf1da9d541018cd19',
        name: '为你写的歌',
        artists: [{ id: '2', name: '方大同' }],
        album: { id: '2', name: '橙月' },
        durationMs: 197_000,
        sourceRef: { kind: 'online' as const, providerId: 'kugou' as const, mediaId: 'dc8087e99400f25bf1da9d541018cd19' },
    };

    it('normalizes it to 你 before comparing, so the title matches', async () => {
        // 真实路径就是这样：先 simplifiedSubject（opencc 把「為」转成「为」、unifySecondPerson
        // 把「妳」转成「你」），再拿简体视图去比候选。
        const subject = await simplifiedSubject(spotify as never);
        expect(scoreSongMatch(subject, kugouHit as never)).toBeGreaterThanOrEqual(85);
    });

    it('also normalizes the search words', async () => {
        const subject = await simplifiedSubject(spotify as never);
        expect(subject.name).toBe('为你写的歌');
    });

    it('does not confuse two different songs', () => {
        const other = { ...kugouHit, name: '特别的人' };
        expect(scoreSongMatch(spotify as never, other as never)).toBe(0);
    });
});
