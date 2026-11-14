import type { AudioQualityPreference, OmniAudioSource } from '../../../types/onlineMusic';

// src/services/onlineMusic/routing/webArchive.ts
//
// 网页存档站（「歌曲宝」gequbao.com）的渲染层入口。
//
// 它是兜底链的最后一步，排在四个曲库之后：星海（按 id 换址）→ 酷我（按标题搜）→ 跨平台同曲
// （网易云 / 酷狗）→ **这里**。理由很直接：这些站不依赖平台版权，曲库是用户上传的，三家里
// 都没有原版的那几首，它往往有。
//
// 2026-11-14 实测（本机直连）：
//   - 搜索页 `/s/<keyword>` 返回 `/music/<id>` 与 `title="歌名 - 歌手"`；
//   - 详情页里的 `window.appData.play_id` 是取址令牌；
//   - POST `/member/common-play-url` 换回 `kw-*.kuwo.cn` 的直链（128 kbps mp3，完整时长）。
//   说好的幸福呢 256.8 s、偏爱 213.0 s、有一种悲伤 237.1 s —— 与平台报告的长度一致。
//
// 抓取与解析都在主进程（electron/webArchive/webArchiveIpc.cjs）：渲染层取不到跨域 HTML，
// 也不该把 DOM 解析放进播放路径。这里只负责「问一次、给候选」。
//
// 一条纪律：拿到的地址一律当作**可疑的完整版**处理——调用方必须自己量时长，因为它给的是
// 用户上传的文件，同名不同录音的情况比平台多。

export const WEB_ARCHIVE_SOURCE_ID = 'gequbao';

export type WebArchiveHit = {
    /** 站内的数字 id，取址时用。 */
    id: string;
    title: string;
    artist: string;
};

type ArchiveBridge = {
    webArchiveSearch?: (payload: { keyword: string }) => Promise<WebArchiveHit[]>;
    webArchiveUrl?: (payload: { id: string }) => Promise<string>;
};

const bridge = (): ArchiveBridge | undefined => (
    typeof window === 'undefined' ? undefined : (window.electron as unknown as ArchiveBridge | undefined)
);

export const isWebArchiveAvailable = (): boolean => Boolean(bridge()?.webArchiveSearch && bridge()?.webArchiveUrl);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 搜一次。任何失败都当成「这个站没有」——它只是最后一步，不该把播放搞挂。 */
export const searchWebArchive = async (keyword: string): Promise<WebArchiveHit[]> => {
    const call = bridge()?.webArchiveSearch;
    if (!call) return [];
    const word = keyword.trim();
    if (!word) return [];
    try {
        const hits = await call({ keyword: word });
        if (!Array.isArray(hits)) return [];
        return hits
            .filter(hit => hit && typeof hit.id === 'string' && /^\d{1,12}$/.test(hit.id) && typeof hit.title === 'string')
            .map(hit => ({ id: hit.id, title: hit.title.trim(), artist: String(hit.artist || '').trim() }))
            .filter(hit => hit.title.length > 0);
    } catch (error) {
        console.info('[Fallback] 存档站搜索失败', { keyword: word, error: describe(error) });
        return [];
    }
};

/**
 * 取一首的地址。归档站只给 128 kbps 的 mp3，所以档位一律报 `standard`：
 * 报高了会让播放器按 lossless 去记级别，之后同一首在别的源上会被判成「降级回退」。
 */
export const fetchWebArchiveAudio = async (id: string): Promise<OmniAudioSource | null> => {
    const call = bridge()?.webArchiveUrl;
    if (!call) return null;
    if (!/^\d{1,12}$/.test(id)) return null;
    try {
        const url = await call({ id });
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
        return { url, quality: 'standard' as AudioQualityPreference, fetchedAt: Date.now() };
    } catch (error) {
        console.info('[Fallback] 存档站取址失败', { id, error: describe(error) });
        return null;
    }
};
