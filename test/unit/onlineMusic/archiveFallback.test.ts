import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLockedSongMappings, tryWebArchive } from '@/services/onlineMusic/routing/lockedSongRouting';
import type { SongResult } from '@/types';

// 兜底链的最后一步：网页存档站（gequbao）。
//
// 三个门槛都必须真的挡住，否则会把「别的录音」当成这首歌放出去——存档站是用户上传的，
// 同名不同录音比平台多得多。这里把搜索、取址、时长探测都换成桩，只测判定本身。
//
// 注意 audioProbe 复用同一个 `<audio>` 元素（模块级单例），所以桩只装一次、每个用例改那张
// 「地址 → 时长」表；每个用例用不同的地址，避免命中探测结果缓存。

const song = {
    id: '4OoExItZJ0jePoCZDbHx4t',
    name: '說好的幸福呢',
    artists: [{ id: '1', name: '周杰伦' }],
    album: { id: '1', name: '魔杰座' },
    durationMs: 256_000,
    sourceRef: { kind: 'online', providerId: 'spotify', mediaId: '4OoExItZJ0jePoCZDbHx4t' },
} as unknown as SongResult;

/** 地址 → 这段音频有多长（秒）。每个用例改写这张表。 */
const durations: Record<string, number> = {};

class FakeAudio {
    duration = 0;
    preload = '';
    muted = false;
    private handlers = new Map<string, Set<() => void>>();

    set src(value: string) {
        this.duration = durations[value] ?? 0;
        // 量不到就当作 error：探测模块会按「不确定」处理。
        setTimeout(() => this.emit(this.duration > 0 ? 'loadedmetadata' : 'error'), 0);
    }
    get src() { return ''; }

    addEventListener(type: string, handler: () => void) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type)!.add(handler);
    }
    removeEventListener(type: string, handler: () => void) {
        this.handlers.get(type)?.delete(handler);
    }
    removeAttribute() { /* 元素留着复用 */ }
    load() { /* noop */ }
    pause() { /* noop */ }
    private emit(type: string) {
        for (const handler of this.handlers.get(type) ?? []) handler();
    }
}

vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);

const stubArchive = (hits: { id: string; title: string; artist: string }[], urls: Record<string, string>) => {
    const resolved: string[] = [];
    vi.stubGlobal('window', {
        electron: {
            webArchiveSearch: async () => hits,
            webArchiveUrl: async ({ id }: { id: string }) => {
                resolved.push(id);
                return urls[id] ?? '';
            },
        },
    });
    return resolved;
};

beforeEach(() => {
    for (const key of Object.keys(durations)) delete durations[key];
    // 「没有这首」会记五分钟；不清的话下一个用例会直接读到上一次的结论。
    forgetLockedSongMappings();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
});

describe('the archive step', () => {
    it('takes the original and reports standard quality', async () => {
        durations['https://archive.test/1288.mp3'] = 256;
        stubArchive(
            [{ id: '1288', title: '说好的幸福呢', artist: '周杰伦' }],
            { 1288: 'https://archive.test/1288.mp3' },
        );

        const source = await tryWebArchive(song, 'high');
        expect(source).toMatchObject({ url: 'https://archive.test/1288.mp3', quality: 'standard' });
    });

    it('never asks for a clip, even though its title matches once normalized', async () => {
        // 「说好的幸福呢(21秒Live片段)」去掉括号后与原名一致，只能按原文挡。
        durations['https://archive.test/1288.mp3'] = 256;
        durations['https://archive.test/live.mp3'] = 21;
        const resolved = stubArchive([
            { id: '24600', title: '说好的幸福呢(21秒Live片段)', artist: '周杰伦' },
            { id: '1288', title: '说好的幸福呢', artist: '周杰伦' },
        ], { 1288: 'https://archive.test/1288.mp3', 24600: 'https://archive.test/live.mp3' });

        const source = await tryWebArchive(song, 'high');
        expect(source?.url).toBe('https://archive.test/1288.mp3');
        expect(resolved).not.toContain('24600');
    });

    it('refuses a different recording: the length has to agree', async () => {
        // 300 秒的现场版；标题与歌手都对得上，只有长度能识破。
        durations['https://archive.test/300.mp3'] = 300;
        stubArchive(
            [{ id: '300', title: '说好的幸福呢', artist: '周杰伦' }],
            { 300: 'https://archive.test/300.mp3' },
        );
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
    });

    it('refuses a cover by another artist', async () => {
        durations['https://archive.test/919052.mp3'] = 256;
        stubArchive(
            [{ id: '919052', title: '说好的幸福呢', artist: '小张' }],
            { 919052: 'https://archive.test/919052.mp3' },
        );
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
    });

    it('gives up when the site has nothing, and when it is not there at all', async () => {
        stubArchive([], {});
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();

        vi.stubGlobal('window', {});
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
    });

    it('tries at most two candidates, then stops', async () => {
        durations['https://archive.test/11.mp3'] = 300;
        durations['https://archive.test/12.mp3'] = 300;
        const resolved = stubArchive(
            [
                { id: '10', title: '说好的幸福呢', artist: '周杰伦' },
                { id: '11', title: '说好的幸福呢', artist: '周杰伦' },
                { id: '12', title: '说好的幸福呢', artist: '周杰伦' },
            ],
            { 11: 'https://archive.test/11.mp3', 12: 'https://archive.test/12.mp3' },
        );
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
        // 每条要两次 HTTP，所以只试前两条：多于两条只是把等待拉长。
        expect(resolved).toHaveLength(2);
    });

    it('does not ask again for a song it has just missed', async () => {
        let asked = 0;
        vi.stubGlobal('window', {
            electron: {
                webArchiveSearch: async () => { asked += 1; return []; },
                webArchiveUrl: async () => '',
            },
        });
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
        const afterFirst = asked;
        await expect(tryWebArchive(song, 'high')).resolves.toBeNull();
        // 预取与播放会连着问同一首，而每次查询是两三次 HTML 抓取。
        expect(asked).toBe(afterFirst);
        expect(afterFirst).toBeGreaterThan(0);
    });
});

// 平台把中文曲名写成英文时，标题判据永远给 0 分。实测：Spotify 的《不该》叫
// `Shouldn't Be`，用英文名搜酷狗只召回《发如雪》《晴天》，而只搜歌手时第一条就是
// 《不该》/ 291 s，与 Spotify 报的 291 s 一致。所以最后一步允许靠「全体歌手 + 长度」认，
// 但只在「至少两位艺人」时——一位艺人加一个长度，证据不足以换一首别的歌上去。
describe('a title written in another language', () => {
    const duet = {
        ...song,
        name: "Shouldn't Be",
        artists: [{ id: '1', name: '周杰伦' }, { id: '2', name: '张惠妹' }],
        durationMs: 291_000,
    } as unknown as SongResult;

    it('accepts the original found by artist, matched on lineup and length', async () => {
        durations['https://archive.test/2119812069.mp3'] = 291;
        stubArchive(
            [{ id: '2119812069', title: '不该', artist: '周杰伦、张惠妹' }],
            { 2119812069: 'https://archive.test/2119812069.mp3' },
        );
        const source = await tryWebArchive(duet, 'high');
        expect(source?.url).toBe('https://archive.test/2119812069.mp3');
    });

    it('still refuses a live take of it', async () => {
        durations['https://archive.test/live2.mp3'] = 301;
        stubArchive(
            [{ id: '60001', title: '不该 (Live)', artist: '周杰伦、张惠妹' }],
            { 60001: 'https://archive.test/live2.mp3' },
        );
        await expect(tryWebArchive(duet, 'high')).resolves.toBeNull();
    });

    it('does not stretch the rule to a single artist', async () => {
        // same length, same (only) artist, different song: one artist is not enough evidence.
        durations['https://archive.test/other.mp3'] = 291;
        stubArchive(
            [{ id: '777', title: '晴天', artist: '周杰伦' }],
            { 777: 'https://archive.test/other.mp3' },
        );
        const solo = { ...duet, artists: [{ id: '1', name: '周杰伦' }] } as unknown as SongResult;
        await expect(tryWebArchive(solo, 'high')).resolves.toBeNull();
    });
});
