import { describe, expect, it, vi } from 'vitest';
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

// 登录会员账号后「会员歌只能试听 1 分钟」：平台给的是一条 60 秒、高码率的试听地址。
// 字节数超过按 48 kbps 算出来的整首下限（4 分钟的歌是 1.44 MB，60 秒 320 kbps 有 2.4 MB），
// 旧代码据此直接判「不是片段」返回，时长那一判据根本没跑过。字节只能证明「一定不是整首」，
// 不能反过来证明「是整首」。
describe('a short answer whose size looks like a whole song', () => {
    class FakeAudio {
        duration = 0;
        preload = '';
        muted = false;
        private handlers = new Map<string, Set<() => void>>();

        set src(value: string) {
            // 这条地址按 240 秒的歌算，只给 60 秒。
            this.duration = value.includes('sixty-seconds') ? 60 : 240;
            setTimeout(() => this.emit('loadedmetadata'), 0);
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

    it('is still called a clip: the size cannot prove otherwise', async () => {
        vi.stubGlobal('window', { electron: { probeAudioSize: async () => 2_400_000 } });
        vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
        const { isClipAudio } = await import('@/services/onlineMusic/audioProbe');

        await expect(isClipAudio('https://example.test/sixty-seconds.mp3', 240_000, { priority: true })).resolves.toBe(true);
        vi.unstubAllGlobals();
    });

    it('keeps a whole song that is simply large', async () => {
        vi.stubGlobal('window', { electron: { probeAudioSize: async () => 9_600_000 } });
        vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
        const { isClipAudio } = await import('@/services/onlineMusic/audioProbe');

        await expect(isClipAudio('https://example.test/whole.mp3', 240_000, { priority: true })).resolves.toBe(false);
        vi.unstubAllGlobals();
    });
});
