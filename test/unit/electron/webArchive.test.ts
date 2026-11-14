import { describe, expect, it } from 'vitest';
import {
    parsePlayId,
    parsePlayUrl,
    parseSearchPage,
} from '../../../electron/webArchive/webArchiveIpc.cjs';

// electron/webArchive/webArchiveIpc.cjs
//
// 这个站没有公开 API：能拿到的只有 HTML。所以三个解析函数是整条链的全部逻辑，值得单独钉住；
// 抓取那一半（net.fetch）由主进程负责，不在这里测。

describe('gequbao search page', () => {
    it('reads the id and the "title - artist" label', () => {
        const html = `
            <div class="row"><a href="/music/44239" class="x" title="为你写的歌 - 方大同">…</a></div>
            <div class="row"><a href="/music/1288" class="x" title="说好的幸福呢 - 周杰伦">…</a></div>`;
        expect(parseSearchPage(html)).toEqual([
            { id: '44239', title: '为你写的歌', artist: '方大同' },
            { id: '1288', title: '说好的幸福呢', artist: '周杰伦' },
        ]);
    });

    it('splits on the last dash, so a subtitle stays in the title', () => {
        // 平台常把副标题写进曲名：「有一种悲伤 - 电影《…》主题曲 - A-Lin」。
        const html = '<a href="/music/7" title="有一种悲伤 - 电影《比悲伤更悲伤的故事》主题曲 - A-Lin">…</a>';
        expect(parseSearchPage(html)).toEqual([
            { id: '7', title: '有一种悲伤 - 电影《比悲伤更悲伤的故事》主题曲', artist: 'A-Lin' },
        ]);
    });

    it('keeps one entry per id, and a label without a dash is all title', () => {
        const html = `
            <a href="/music/7" title="只有歌名">a</a>
            <a href="/music/7" title="只有歌名">b</a>`;
        expect(parseSearchPage(html)).toEqual([{ id: '7', title: '只有歌名', artist: '' }]);
    });

    it('ignores anything that is not a numeric music link', () => {
        const html = '<a href="/search?name=x" title="不关事">x</a><a href="/music/abc" title="也不是">y</a>';
        expect(parseSearchPage(html)).toEqual([]);
    });

    it('decodes the entities the page writes into the label', () => {
        const html = '<a href="/music/9" title="A &amp; B - 歌手 &amp; 另一位">x</a>';
        expect(parseSearchPage(html)).toEqual([{ id: '9', title: 'A & B', artist: '歌手 & 另一位' }]);
    });
});

describe('gequbao detail page', () => {
    // 真实页面里的形状：单引号包一段被 \u0022 转义过的 JSON。
    const page = `<script>window.appData = JSON.parse('{"mp3_id":44239,"play_id":"eyJpdiI6Ik4yT21tV1MrdWlOSjFHNTByYzc3d1E9PSJ9","mp3_title":"\\u4e3a\\u4f60\\u5199\\u7684\\u6b4c"}');</script>`;

    it('reads the play token', () => {
        expect(parsePlayId(page)).toBe('eyJpdiI6Ik4yT21tV1MrdWlOSjFHNTByYzc3d1E9PSJ9');
    });

    it('returns nothing when the page has no token', () => {
        expect(parsePlayId('<html><body>404</body></html>')).toBe('');
        expect(parsePlayId('window.appData = JSON.parse(\'{"mp3_id":1}\');')).toBe('');
    });

    it('survives a broken payload instead of throwing', () => {
        expect(parsePlayId("window.appData = JSON.parse('{not json');")).toBe('');
    });
});

describe('gequbao play-url answer', () => {
    it('takes the address out of data.url', () => {
        const body = JSON.stringify({ code: 1, data: { url: 'https://kw-lv.kuwo.cn/a/b.mp3?bitrate$128' }, msg: '操作成功' });
        expect(parsePlayUrl(body)).toBe('https://kw-lv.kuwo.cn/a/b.mp3?bitrate$128');
    });

    it('refuses a non-http answer and a refusal', () => {
        expect(parsePlayUrl(JSON.stringify({ code: 0, msg: '需要卡密' }))).toBe('');
        expect(parsePlayUrl(JSON.stringify({ code: 1, data: { url: 'javascript:alert(1)' } }))).toBe('');
        expect(parsePlayUrl('<html>502</html>')).toBe('');
    });
});
