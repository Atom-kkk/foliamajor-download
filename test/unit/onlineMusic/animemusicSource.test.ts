import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    animemusicQualityParam,
    animemusicSourceOf,
    fetchAnimemusicAudio,
    isAnimemusicAvailable,
    parseAnimemusicAudio,
    servedQuality,
} from '@/services/onlineMusic/animemusic/animemusic';
import { animemusicProvider } from '@/services/onlineMusic/animemusic/animemusicProvider';
import { buildBody, SOURCES } from '../../../electron/animemusic/animemusicIpc.cjs';

// test/unit/onlineMusic/animemusicSource.test.ts
// 聚合音源的解析、平台映射、参数白名单与 provider 取址。样本取自 2026-11-21 的真实回答
// （网易云会员曲成功 / QQ 500 / 限流 429），不联网。

const ok = (url: string) => JSON.stringify({ code: 200, url });

describe('AnimeMusic source parsing', () => {
    it('reads the address and labels flac as lossless', () => {
        expect(parseAnimemusicAudio(ok('https://m701.music.126.net/x/y.flac'))).toEqual({
            url: 'https://m701.music.126.net/x/y.flac',
            quality: 'lossless',
        });
    });

    it('labels an mp3 by the level it was asked for, never above high', () => {
        const mp3 = ok('https://m701.music.126.net/x/y.mp3');
        expect(parseAnimemusicAudio(mp3, 'standard').quality).toBe('standard');
        expect(parseAnimemusicAudio(mp3, 'high').quality).toBe('high');
        // 问了无损却回了 mp3：记 high，不替后端保证无损。
        expect(parseAnimemusicAudio(mp3, 'lossless').quality).toBe('high');
        expect(parseAnimemusicAudio(mp3, 'hires').quality).toBe('high');
    });

    it('labels the kuwo / qishui proxy addresses from the level asked', () => {
        // 酷我回的是 `kwplay.php?mid=..&q=320k`，路径上没有扩展名。
        expect(servedQuality('https://yy.zddyr.top/lx/api/kwplay.php?mid=1&q=320k', 'lossless')).toBe('high');
        expect(servedQuality('https://animemusic.bzxhkj.com/v1/index.php/music/proxy?u=x', 'standard')).toBe('standard');
    });

    it('keeps "this source cannot serve it" apart from "this song has no link"', () => {
        // 真实回答：QQ 源就这样。它表示「这首拿不到」，路由该继续换候选。
        expect(() => parseAnimemusicAudio('{"code":500,"message":"获取URL失败"}')).toThrowError(/获取URL失败/);
        try {
            parseAnimemusicAudio('{"code":500,"message":"获取URL失败"}');
        } catch (error) {
            expect((error as { code?: string }).code).toBe('not-playable');
        }
        // 限流与鉴权是「这个源现在给不了」，与「这首没有」分开。
        try {
            parseAnimemusicAudio('{"code":429,"message":"请求过速"}');
        } catch (error) {
            expect((error as { code?: string }).code).toBe('unavailable');
        }
    });

    it('refuses an answer with no playable url', () => {
        expect(() => parseAnimemusicAudio('{"code":200,"url":""}')).toThrowError(/没有可播放的地址/);
        expect(() => parseAnimemusicAudio('{"code":200,"url":"javascript:alert(1)"}')).toThrowError(/没有可播放的地址/);
        expect(() => parseAnimemusicAudio('<html>502</html>')).toThrowError(/不是 JSON/);
    });
});

describe('AnimeMusic platform mapping', () => {
    it('maps the platforms whose media id the backend can take', () => {
        expect(animemusicSourceOf('netease')).toBe('wy');
        expect(animemusicSourceOf('kugou')).toBe('kg');
        expect(animemusicSourceOf('kuwo')).toBe('kw');
        expect(animemusicSourceOf('qq')).toBe('tx');
        expect(animemusicSourceOf('qishui')).toBe('qishui');
    });

    it('leaves platforms the backend does not know alone', () => {
        expect(animemusicSourceOf('spotify')).toBeNull();
        expect(animemusicSourceOf('ytm')).toBeNull();
        expect(animemusicSourceOf('animemusic')).toBeNull();
    });

    it('asks for the level the preference stands for', () => {
        expect(animemusicQualityParam('standard')).toBe('128k');
        expect(animemusicQualityParam('high')).toBe('320k');
        expect(animemusicQualityParam('ultra')).toBe('320k');
        expect(animemusicQualityParam('lossless')).toBe('flac');
        expect(animemusicQualityParam('hires')).toBe('flac24bit');
    });
});

describe('AnimeMusic main-process argument whitelist', () => {
    it('takes the three parameters and nothing else', () => {
        expect(buildBody({ source: 'wy', musicId: ' 2659565914 ', quality: 'flac', url: 'https://evil.example' })).toEqual({
            source: 'wy',
            musicId: '2659565914',
            quality: 'flac',
        });
    });

    it('refuses a platform it does not serve', () => {
        expect(SOURCES.has('wy')).toBe(true);
        expect(() => buildBody({ source: 'bilibili', musicId: '1' })).toThrowError(/does not serve/);
        expect(() => buildBody({ source: 'wy', musicId: '' })).toThrowError(/needs a musicId/);
    });
});

describe('AnimeMusic provider', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const song = {
        id: '2659565914',
        name: '天亮以前说再见',
        artists: [{ id: '1', name: '徐化文' }],
        album: { id: '1', name: '天亮以前说再见' },
        durationMs: 233_000,
        sourceRef: { kind: 'online' as const, providerId: 'netease' as const, mediaId: '2659565914' },
    };

    it('is desktop only, and says so', () => {
        expect(isAnimemusicAvailable()).toBe(false);
        expect(animemusicProvider.getAvailability?.()).toEqual({ configured: false, reason: 'runtime-unavailable' });
    });

    it('swaps the address of the song it is given, on that song platform', async () => {
        const call = vi.fn(async () => ({
            status: 200,
            text: ok('https://m701.music.126.net/x/y.flac'),
        }));
        vi.stubGlobal('window', { electron: { animemusicAudioUrl: call } });

        const source = await animemusicProvider.playback!.getAudioSource(song, 'lossless');

        expect(call).toHaveBeenCalledWith({ source: 'wy', musicId: '2659565914', quality: 'flac' });
        expect(source?.url).toBe('https://m701.music.126.net/x/y.flac');
        expect(source?.quality).toBe('lossless');
        // 是否片段由路由实测，provider 自己不下结论。
        expect(source?.preview).toBeUndefined();
    });

    it('refuses a platform the backend does not take, without calling it', async () => {
        const call = vi.fn();
        vi.stubGlobal('window', { electron: { animemusicAudioUrl: call } });

        await expect(animemusicProvider.playback!.getAudioSource(
            { ...song, sourceRef: { kind: 'online' as const, providerId: 'spotify', mediaId: 'abc' } },
            'standard',
        )).rejects.toThrowError(/不接这个平台/);
        expect(call).not.toHaveBeenCalled();
    });

    it('turns a 5xx proxy answer into "unavailable"', async () => {
        vi.stubGlobal('window', { electron: { animemusicAudioUrl: async () => ({ status: 502, text: '' }) } });
        await expect(fetchAnimemusicAudio({ providerId: 'netease', mediaId: '1' }, 'standard'))
            .rejects.toMatchObject({ code: 'unavailable' });
    });
});
