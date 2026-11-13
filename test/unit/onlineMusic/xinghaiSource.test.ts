import { describe, expect, it } from 'vitest';
import { parseXinghaiAudio } from '@/services/onlineMusic/xinghai/xinghai';

// test/unit/onlineMusic/xinghaiSource.test.ts
// 星海后端的回答解析。样本取自真实响应（QQ 320k 成功 / 403 未授权 / 500 无链接）。

describe('XingHai source parsing', () => {
    it('reads the address and the quality the backend actually served', () => {
        expect(parseXinghaiAudio(JSON.stringify({
            code: 200,
            url: 'http://wx.music.tc.qq.com/M8000039MnYb0qxYhV.mp3?vkey=abc',
            quality: '320k',
            format: 'mp3',
            service: 'unified',
        }))).toMatchObject({
            url: 'http://wx.music.tc.qq.com/M8000039MnYb0qxYhV.mp3?vkey=abc',
            quality: 'high',
            format: 'mp3',
        });
    });

    it('labels flac answers as lossless, whatever byte rate the field carries', () => {
        expect(parseXinghaiAudio('{"code":200,"url":"http://a/1.flac","quality":"flac"}').quality).toBe('lossless');
        expect(parseXinghaiAudio('{"code":200,"url":"http://a/2.flac","quality":"flac24bit"}').quality).toBe('hires');
    });

    it('keeps "this source cannot serve it" apart from "this song has no link"', () => {
        // 403/429/503：路由该回退到内置源原本的行为。
        expect(() => parseXinghaiAudio('{"code":403,"msg":"该音源仅对认证用户开放"}')).toThrowError(/认证用户/);
        try {
            parseXinghaiAudio('{"code":403,"msg":"该音源仅对认证用户开放"}');
        } catch (error) {
            expect((error as { code?: string }).code).toBe('unavailable');
        }
        try {
            parseXinghaiAudio('{"code":500,"msg":"获取失败"}');
        } catch (error) {
            expect((error as { code?: string }).code).toBe('not-playable');
        }
    });

    it('refuses an answer with no playable url', () => {
        expect(() => parseXinghaiAudio('{"code":200,"url":""}')).toThrowError(/没有可播放的地址/);
        expect(() => parseXinghaiAudio('<html>502</html>')).toThrowError(/不是 JSON/);
    });
});
