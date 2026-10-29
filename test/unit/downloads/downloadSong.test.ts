import { describe, expect, it } from 'vitest';
import { downloadExtension, downloadFileName } from '@/services/downloads/downloadSong';
import { isDifferentVersion } from '@/services/downloads/fullSource';

// test/unit/downloads/downloadSong.test.ts
// 下载的两个纯函数：文件后缀怎么定、建议文件名怎么拼。不联网、不碰 IPC。

describe('song download naming', () => {
    it('takes the extension from the address when the CDN states one', () => {
        expect(downloadExtension('https://m8.music.126.net/a/b/song.flac?auth=1', 'standard')).toBe('flac');
        expect(downloadExtension('http://ws.stream.qqmusic.qq.com/M800x.m4a?vkey=1', 'high')).toBe('m4a');
        expect(downloadExtension('https://cdn/x.mp3', 'lossless')).toBe('mp3');
    });

    it('falls back to the quality when the address has no extension', () => {
        expect(downloadExtension('https://api.example.com/stream?id=1', 'lossless')).toBe('flac');
        expect(downloadExtension('https://api.example.com/stream?id=1', 'hires')).toBe('flac');
        expect(downloadExtension('https://api.example.com/stream?id=1', 'high')).toBe('mp3');
    });

    it('builds “artist - title”, and survives a song with no artist', () => {
        expect(downloadFileName({
            id: '1',
            name: '告白气球',
            artists: [{ id: '2', name: '周杰伦' }],
        } as never)).toBe('周杰伦 - 告白气球');

        expect(downloadFileName({ id: '1', name: '纯音乐', artists: [] } as never)).toBe('纯音乐');
    });
});

describe('version matching for downloads', () => {
    it('rejects the same title with a different qualifier', () => {
        // 真实案例：酷我搜到的是跨年晚会现场版，时长只差 2 秒，评分与原版一样高。
        expect(isDifferentVersion('少一点天分', '少一点天分 (2015 桃园升格幸福无限跨年晚会)')).toBe(true);
    });

    it('accepts the identical title, qualifier and all', () => {
        expect(isDifferentVersion('少一点天分', '少一点天分')).toBe(false);
        expect(isDifferentVersion('告白气球 (Live)', '告白气球（Live）')).toBe(false);
    });

    it('leaves titles with a different body to the score', () => {
        expect(isDifferentVersion('晴天', '七里香')).toBe(false);
        expect(isDifferentVersion('告白气球', '告白气球（DJ版）')).toBe(true);
    });

    it('catches version words that are not inside brackets', () => {
        // 「少一点天分 现场版」没有括号，只看括号会漏掉。
        expect(isDifferentVersion('少一点天分', '少一点天分 现场版')).toBe(true);
        expect(isDifferentVersion('晴天', '晴天 伴奏')).toBe(true);
        // 原歌自己就是现场版时不排除。
        expect(isDifferentVersion('晴天 Live', '晴天 Live')).toBe(false);
    });
});
