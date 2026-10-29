import { describe, expect, it } from 'vitest';
import { looksLikeClip, looksLikeClipBySize } from '@/services/onlineMusic/audioProbe';

// test/unit/onlineMusic/audioProbe.test.ts
// 片段判定只在两个条件同时成立时返回 true：不到 70%，且至少短 20 秒。
// 两个条件都留着，是为了短歌不被误伤（一首 1:30 的歌给 1:20，比例成立但实在不算片段）。

describe('clip detection', () => {
    it('calls a 30-second answer for a four-minute song a clip', () => {
        expect(looksLikeClip(30_000, 274_000)).toBe(true);
    });

    it('leaves a nearly complete answer alone', () => {
        expect(looksLikeClip(260_000, 274_000)).toBe(false);
        // 短歌：比例够了，但只差 10 秒，不当片段。
        expect(looksLikeClip(80_000, 90_000)).toBe(false);
    });

    it('never guesses without a measurement or without a known length', () => {
        expect(looksLikeClip(null, 274_000)).toBe(false);
        expect(looksLikeClip(30_000, 0)).toBe(false);
    });
});

describe('clip detection by file size', () => {
    // 实测样本：网易云给这首歌的是 801,271 字节（约 50 秒），歌曲本身 291,944 ms；
    // 星海给的是 11,679,913 字节（约 292 秒）。
    it('flags the 800 KB answer for a five-minute song', () => {
        expect(looksLikeClipBySize(801_271, 291_944)).toBe(true);
    });

    it('accepts the complete file', () => {
        expect(looksLikeClipBySize(11_679_913, 291_944)).toBe(false);
    });

    it('leaves short songs and unknown sizes alone', () => {
        // 60 秒的歌 500 KB（≈66 kbps）是完整文件，不该被当成片段。
        expect(looksLikeClipBySize(500_000, 60_000)).toBe(false);
        expect(looksLikeClipBySize(null, 291_944)).toBe(false);
        expect(looksLikeClipBySize(801_271, 0)).toBe(false);
    });
});
