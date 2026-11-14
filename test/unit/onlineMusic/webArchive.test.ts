import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWebArchiveAudio, isWebArchiveAvailable, searchWebArchive } from '@/services/onlineMusic/routing/webArchive';

// src/services/onlineMusic/routing/webArchive.ts
//
// 渲染层这一侧只做三件事：把参数交给主进程、把回来的东西验一遍、失败当成「这个站没有」。
// 采样取自 2026-11-14 对 gequbao 的实测。

const withBridge = (bridge: Record<string, unknown>) => {
    vi.stubGlobal('window', { electron: bridge });
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('searchWebArchive', () => {
    it('hands the keyword over and keeps only usable rows', async () => {
        withBridge({
            webArchiveSearch: async () => [
                { id: '44239', title: '为你写的歌', artist: '方大同' },
                // 站内的非数字 id 与空标题不该进入比较
                { id: 'music-44239', title: '假的', artist: '' },
                { id: '7', title: '   ', artist: '谁' },
            ],
            webArchiveUrl: async () => '',
        });
        await expect(searchWebArchive('为你写的歌 方大同')).resolves.toEqual([
            { id: '44239', title: '为你写的歌', artist: '方大同' },
        ]);
    });

    it('answers with an empty list when the site fails or says nothing', async () => {
        withBridge({
            webArchiveSearch: async () => { throw new Error('HTTP 502'); },
            webArchiveUrl: async () => '',
        });
        await expect(searchWebArchive('为你写的歌')).resolves.toEqual([]);

        withBridge({ webArchiveSearch: async () => null, webArchiveUrl: async () => '' });
        await expect(searchWebArchive('为你写的歌')).resolves.toEqual([]);

        withBridge({ webArchiveSearch: async () => [], webArchiveUrl: async () => '' });
        await expect(searchWebArchive('   ')).resolves.toEqual([]);
    });

    it('is unavailable outside the desktop shell', async () => {
        vi.stubGlobal('window', {});
        expect(isWebArchiveAvailable()).toBe(false);
        await expect(searchWebArchive('为你写的歌')).resolves.toEqual([]);
        await expect(fetchWebArchiveAudio('44239')).resolves.toBeNull();
    });
});

describe('fetchWebArchiveAudio', () => {
    it('reports standard quality: the site only ever serves 128 kbps', async () => {
        withBridge({
            webArchiveSearch: async () => [],
            webArchiveUrl: async () => 'https://kw-lv.kuwo.cn/a/b.mp3?bitrate$128',
        });
        const source = await fetchWebArchiveAudio('44239');
        // 报高了会被记成「降级回退」，之后同一首在别的源上判级别就不对了。
        expect(source).toMatchObject({ quality: 'standard', url: 'https://kw-lv.kuwo.cn/a/b.mp3?bitrate$128' });
        expect(typeof source?.fetchedAt).toBe('number');
    });

    it('refuses an id that is not the site own numbering', async () => {
        const call = vi.fn(async () => 'https://kw-lv.kuwo.cn/a/b.mp3');
        withBridge({ webArchiveSearch: async () => [], webArchiveUrl: call });
        await expect(fetchWebArchiveAudio('../../etc/passwd')).resolves.toBeNull();
        await expect(fetchWebArchiveAudio('44239x')).resolves.toBeNull();
        expect(call).not.toHaveBeenCalled();
    });

    it('refuses an answer that is not an http address', async () => {
        withBridge({ webArchiveSearch: async () => [], webArchiveUrl: async () => 'javascript:alert(1)' });
        await expect(fetchWebArchiveAudio('44239')).resolves.toBeNull();
    });

    it('answers null instead of throwing when the main process errors', async () => {
        withBridge({
            webArchiveSearch: async () => [],
            webArchiveUrl: async () => { throw new Error('gequbao play-url answered HTTP 429'); },
        });
        await expect(fetchWebArchiveAudio('44239')).resolves.toBeNull();
    });
});
