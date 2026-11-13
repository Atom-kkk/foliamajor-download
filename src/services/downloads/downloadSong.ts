import type { SongResult } from '../../types';
import type { AudioQualityPreference } from '../../types/onlineMusic';
import { getProviderSongMetadata } from '../onlineMusic/songMetadata';
import { hasCachedAudio } from '../audioCache';
import { getSongResourceCacheKey } from '../onlineMusic/resourceKeys';
import { resolveFullAudioSource } from './fullSource';

// src/services/downloads/downloadSong.ts
//
// 把正在看/正在听的在线歌曲存成一个文件。
//
// 取地址走 `resolveFullAudioSource`：它先在歌曲自己的源里找**完整版**，找不到就跨源按「标题 +
// 歌手」匹配（酷我 / 其它已登录源），最后才按原平台 id 问星海。播放可以接受试听片段，下载不行，
// 所以这里拒绝任何 `preview` 地址，而不是先把一个 30 秒的文件存下来。
//
// 写盘在主进程（electron/downloads/audioDownload.cjs）：保存位置只来自系统对话框。

export type DownloadOutcome = {
    canceled: boolean;
    filePath: string | null;
    bytes: number;
};

export type DownloadErrorCode = 'unsupported' | 'no-full-version';

export class DownloadError extends Error {
    constructor(public readonly code: DownloadErrorCode, message: string) {
        super(message);
        this.name = 'DownloadError';
    }
}

const EXTENSIONS = ['flac', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'mp3'] as const;

/** 地址后缀优先（CDN 一般带真实的 .flac/.mp3），没有就按档位猜。 */
export const downloadExtension = (url: string, quality: AudioQualityPreference): string => {
    let pathname = '';
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        pathname = url.toLowerCase().split('?')[0] ?? '';
    }
    const matched = EXTENSIONS.find(extension => pathname.endsWith(`.${extension}`));
    if (matched) return matched;
    return quality === 'lossless' || quality === 'hires' ? 'flac' : 'mp3';
};

const bridge = () => (typeof window === 'undefined' ? undefined : window.electron);

export const canDownloadSongs = (): boolean => Boolean(bridge()?.downloadAudio);

/** `歌手 - 歌名`，与用户手动整理时的习惯一致；非法字符由主进程再清洗一次。 */
export const downloadFileName = (song: SongResult): string => {
    const artists = getProviderSongMetadata(song).artists.map(artist => artist.name).filter(Boolean).join(', ');
    const name = [artists, song.name].filter(Boolean).join(' - ');
    return name || 'folia-audio';
};

export const downloadSong = async (
    song: SongResult,
    quality: AudioQualityPreference = 'high',
): Promise<DownloadOutcome> => {
    const api = bridge()?.downloadAudio;
    if (!api) {
        throw new DownloadError('unsupported', '下载只在桌面端可用');
    }

    // 1) 先按「同一版本」取址：版本正确比「和缓存字节一致」更重要——缓存里那份可能是
    //    兜底换源换错的伴奏版。取址会排除伴奏/现场/翻唱（见 songVersionMatch）。
    const resolved = await resolveFullAudioSource(song, quality);
    if (resolved) {
        return api({
            url: resolved.source.url,
            defaultName: downloadFileName(song),
            extension: downloadExtension(resolved.source.url, resolved.source.quality ?? quality),
        });
    }

    // 2) 取不到再用播放缓存：至少能拿到听到的那一份，总比什么都不给好。
    const saveCached = bridge()?.downloadCachedAudio;
    if (saveCached) {
        const cacheKey = getSongResourceCacheKey('audio', song);
        if (cacheKey && await hasCachedAudio(cacheKey)) {
            const cached = await saveCached({ cacheKey, defaultName: downloadFileName(song) });
            if (cached.fromCache) {
                return { canceled: cached.canceled, filePath: cached.filePath, bytes: cached.bytes };
            }
        }
    }

    throw new DownloadError('no-full-version', '所有音源都只给了试听片段，这一首没有完整版本可下载');
};
