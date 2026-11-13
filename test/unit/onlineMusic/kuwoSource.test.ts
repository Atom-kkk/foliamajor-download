import { describe, expect, it } from 'vitest';
import { parseKuwoAudio, parseKuwoLyric, parseKuwoSearch } from '@/services/onlineMusic/kuwo/kuwo';

// test/unit/onlineMusic/kuwoSource.test.ts
// 酷我源的解析层。样本取自真实回答的形状（单引号对象字面量、`\'` 转义、`&nbsp;`、bitrate 的
// 20201 这类标记值），不联网。

const SEARCH_SAMPLE = `{'HIT':'454','TOTAL':'454','abslist':[{'ALBUM':'2018中央电视台春节联欢晚会','ALBUMID':'5401355','ARTIST':'周杰伦','ARTISTID':'336','DURATION':'140','MUSICRID':'MUSIC_40614186','NAME':'告白气球','AARTIST':'Jay&nbsp;Chou'},{'ALBUM':'Demo','ALBUMID':'77','ARTIST':'A\\'B','ARTISTID':'9','DURATION':'200','MUSICRID':'MUSIC_123','NAME':'It\\'s ok'}]}`;

describe('KuWo source parsing', () => {
    it('reads every song of a search answer, with escapes and entities decoded', () => {
        const page = parseKuwoSearch(SEARCH_SAMPLE);
        expect(page.total).toBe(454);
        expect(page.items).toHaveLength(2);

        const [first, second] = page.items;
        expect(first).toMatchObject({
            id: '40614186',
            name: '告白气球',
            durationMs: 140_000,
            album: { id: '5401355', name: '2018中央电视台春节联欢晚会' },
            sourceRef: { kind: 'online', providerId: 'kuwo', mediaId: '40614186' },
        });
        expect(first.artists).toEqual([{ id: '336', name: '周杰伦' }]);

        // 单引号转义与 `&nbsp;` 都要还原，否则列表里会出现反斜杠。
        expect(second.name).toBe("It's ok");
        expect(second.artists).toEqual([{ id: '9', name: "A'B" }]);
    });

    it('labels the quality by what the bitrate actually says', () => {
        expect(parseKuwoAudio('{"code":200,"data":{"url":"http://a/1.mp3","bitrate":320,"duration":211}}')).toMatchObject({
            url: 'http://a/1.mp3',
            quality: 'high',
            durationMs: 211_000,
        });
        expect(parseKuwoAudio('{"code":200,"data":{"url":"http://a/2.mp3","bitrate":128}}').quality).toBe('standard');
        // 20201 是酷我自己的无损标记，不是 kbps。
        expect(parseKuwoAudio('{"code":200,"data":{"url":"http://a/3.flac","bitrate":20201}}').quality).toBe('lossless');
    });

    it('tells “no address” apart from “a malformed answer”', () => {
        expect(() => parseKuwoAudio('{"code":200,"data":{}}')).toThrowError(/没有地址|地址/);
        expect(() => parseKuwoAudio('{"code":403,"msg":"denied"}')).toThrowError(/code 403/);
        expect(() => parseKuwoAudio('<html>502</html>')).toThrowError(/不是 JSON/);
    });

    it('turns the lyric list into LRC lines with two-decimal stamps', () => {
        const { lrc } = parseKuwoLyric(JSON.stringify({
            data: {
                lrclist: [
                    { lineLyric: '告白气球 - 周杰伦', time: '0.0' },
                    { lineLyric: '塞纳河畔 左岸的咖啡', time: '1.26' },
                    { lineLyric: '', time: '2' },
                ],
            },
        }));
        expect(lrc.split('\n')).toEqual([
            '[00:00.00]告白气球 - 周杰伦',
            '[00:01.26]塞纳河畔 左岸的咖啡',
        ]);
    });
});
