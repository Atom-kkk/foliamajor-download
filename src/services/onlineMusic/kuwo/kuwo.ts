import type { AudioQualityPreference } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { UnifiedSong } from '../../../types';

// src/services/onlineMusic/kuwo/kuwo.ts
//
// 酷我官方接口的读写，从 LX 自定义源 `無名v0.0.3.js`（仓库 xzh767/lxmusic-source-all）里那条
// 「直连酷我」的实现搬过来，去掉了脚本运行时：
//
//   搜索  http://search.kuwo.cn/r.s?all=<词>&ft=music&itemset=web_2013&client=kt&pn=<页>&rn=<条>
//         -> 一段 JS 对象字面量（单引号），`abslist` 里每首一条
//   取址  https://nmobi.kuwo.cn/mobi.s?f=web&source=...&type=convert_url_with_sign&rid=<id>&br=<br>
//         -> { code: 200, data: { url, bitrate, duration } }
//   歌词  http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=<id>
//         -> { data: { lrclist: [{ lineLyric, time }] } }
//
// 搜索端点不返回 `Access-Control-Allow-Origin`，渲染层的 fetch 到不了，所以三条都走主进程的窄代理
// （electron/kuwo/kuwoIpc.cjs）：那里只收参数、URL 由主进程拼死。
//
// 搜索的回答是 JS 对象字面量而不是 JSON，这里用逐字段的正则解析，不 `eval` 远端文本；字段值里的
// `\'` 与常见 HTML 实体会还原。

export const KUWO_SOURCE_ID = 'kuwo';

type BridgeResult = { status: number; text: string };

const bridge = () => (typeof window === 'undefined' ? undefined : window.electron);

/** 这个源只在带酷我代理的桌面端可用。 */
export const isKuwoAvailable = (): boolean => Boolean(bridge()?.kuwoSearch);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const callBridge = async (
    what: string,
    run: (() => Promise<BridgeResult>) | undefined,
): Promise<string> => {
    if (!run) {
        throw new OnlineProviderError('unavailable', '酷我音源只在桌面端可用（需要主进程代理）', KUWO_SOURCE_ID);
    }
    let result: BridgeResult;
    try {
        result = await run();
    } catch (error) {
        throw new OnlineProviderError('network', `酷我${what}请求失败：${describe(error)}`, KUWO_SOURCE_ID, error);
    }
    if (result.status >= 500) {
        throw new OnlineProviderError('unavailable', `酷我${what}暂时不可用（HTTP ${result.status}）`, KUWO_SOURCE_ID, undefined, result.status);
    }
    if (result.status >= 400) {
        throw new OnlineProviderError('unavailable', `酷我${what}被拒绝（HTTP ${result.status}）`, KUWO_SOURCE_ID, undefined, result.status);
    }
    return result.text;
};

const decodeEntities = (value: string): string => value
    .replace(/\\'/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** `KEY:'value'` 的值（酷我的键名本身也带引号：`'KEY':'value'`），没有时为空串。 */
const field = (row: string, key: string): string => {
    const match = row.match(new RegExp(`${key}'?\\s*:\\s*'((?:\\\\.|[^'])*)'`));
    return match ? decodeEntities(match[1]).trim() : '';
};

/** `abslist` 里的每一条。按 `},{` 切开——酷我的字段值里不会出现这个组合。 */
const rowsOf = (text: string): string[] => {
    // 键名也可能带引号：`'abslist':[`
    const marker = /abslist'?\s*:\s*\[/.exec(text);
    if (!marker) return [];
    const body = text.slice(marker.index + marker[0].length);
    return body
        .split('},{')
        .map((row, index, all) => {
            let value = row;
            if (index === 0) value = value.replace(/^\{/, '');
            if (index === all.length - 1) value = value.replace(/\}?\s*\]?,?\s*$/, '');
            return value;
        })
        .filter(row => /MUSICRID'?\s*:/.test(row));
};

const normalizeKuwoSong = (row: string): UnifiedSong | null => {
    const rid = (field(row, 'MUSICRID').match(/(\d+)/) || [])[1] || '';
    const name = field(row, 'NAME');
    if (!rid || !name) return null;
    const artist = field(row, 'ARTIST');
    const durationSec = Number(field(row, 'DURATION')) || 0;
    const albumId = field(row, 'ALBUMID');
    return {
        id: rid,
        name,
        artists: artist ? [{ id: field(row, 'ARTISTID'), name: artist }] : [],
        album: { id: albumId, name: field(row, 'ALBUM'), coverUrl: '' },
        durationMs: Math.max(0, durationSec) * 1000,
        sourceRef: { kind: 'online', providerId: KUWO_SOURCE_ID, mediaId: rid },
    };
};

export type KuwoSearchPage = {
    items: UnifiedSong[];
    /** 这次回答里说的一共多少条；没给就是 `items.length`。 */
    total: number;
};

/** 把酷我的搜索回答（JS 对象字面量）读成歌曲。纯函数：单测直接喂样本。 */
export const parseKuwoSearch = (text: string): KuwoSearchPage => {
    if (!/abslist'?\s*:\s*\[/.test(text) && !/^(<!DOCTYPE|<html)/i.test(text.trim()) && text.length < 200) {
        // 一句错误话而不是列表：多半是参数被拒，交给上层当一次失败。
        throw new OnlineProviderError('invalid-response', `酷我搜索的回答不是列表：${text.slice(0, 80)}`, KUWO_SOURCE_ID);
    }
    const rows = rowsOf(text);
    const items = rows.map(normalizeKuwoSong).filter((song): song is UnifiedSong => song !== null);
    const total = Number((text.match(/TOTAL'?\s*:\s*'?(\d+)/) || [])[1]) || items.length;
    return { items, total };
};

export const searchKuwo = async (keyword: string, limit: number, offset: number): Promise<KuwoSearchPage> => {
    const text = await callBridge('搜索', bridge()?.kuwoSearch
        ? () => bridge()!.kuwoSearch!({ keyword, limit, offset })
        : undefined);
    return parseKuwoSearch(text);
};

/** 酷我 `br` 的标记值：20201/2000 一类是它自己的无损写法，不按 kbps 读。 */
const qualityOf = (bitrate: number): AudioQualityPreference => {
    if (!Number.isFinite(bitrate) || bitrate <= 0) return 'standard';
    if (bitrate >= 1000) return 'lossless';
    if (bitrate >= 192) return 'high';
    return 'standard';
};

export type KuwoAudio = {
    url: string;
    quality: AudioQualityPreference;
    durationMs: number;
};

/** 把取址回答读成地址与「实际是哪一档」。纯函数。 */
export const parseKuwoAudio = (text: string): KuwoAudio => {
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new OnlineProviderError('invalid-response', `酷我取址的回答不是 JSON：${text.slice(0, 80)}`, KUWO_SOURCE_ID);
    }
    if (Number(body?.code) !== 200) {
        throw new OnlineProviderError('not-playable', `酷我没有给这首歌地址（code ${String(body?.code)}）`, KUWO_SOURCE_ID);
    }
    const url = typeof body?.data?.url === 'string' ? body.data.url.trim() : '';
    if (!url) {
        throw new OnlineProviderError('not-playable', '酷我的回答里没有地址', KUWO_SOURCE_ID);
    }
    const durationSec = Number(body?.data?.duration) || 0;
    return {
        url,
        quality: qualityOf(Number(body?.data?.bitrate)),
        durationMs: Math.max(0, durationSec) * 1000,
    };
};

export const fetchKuwoAudio = async (rid: string, asked: AudioQualityPreference): Promise<KuwoAudio> => {
    const text = await callBridge('取址', bridge()?.kuwoAudioUrl
        ? () => bridge()!.kuwoAudioUrl!({ rid, quality: asked })
        : undefined);
    return parseKuwoAudio(text);
};

const lrcStamp = (seconds: number): string => {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `[${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}]`;
};

/** 把歌词回答读成 LRC。纯函数。 */
export const parseKuwoLyric = (text: string): { lrc: string } => {
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new OnlineProviderError('invalid-response', '酷我歌词的回答不是 JSON', KUWO_SOURCE_ID);
    }
    const lines = Array.isArray(body?.data?.lrclist) ? body.data.lrclist : [];
    const lrc = lines
        .map((line: any) => {
            const words = typeof line?.lineLyric === 'string' ? line.lineLyric : '';
            const time = Number(line?.time);
            return words ? `${lrcStamp(Number.isFinite(time) ? time : 0)}${words}` : '';
        })
        .filter(Boolean)
        .join('\n');
    return { lrc };
};

export const fetchKuwoLyric = async (rid: string): Promise<{ lrc: string; translated?: string }> => {
    const text = await callBridge('歌词', bridge()?.kuwoLyric
        ? () => bridge()!.kuwoLyric!({ rid })
        : undefined);
    return parseKuwoLyric(text);
};
