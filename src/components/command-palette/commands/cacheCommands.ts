import { RefreshCw } from 'lucide-react';
import { defineCommand } from '../commandFactories';
import type { CommandPaletteCommand } from '../types';

// src/components/command-palette/commands/cacheCommands.ts
// 丢掉当前歌曲的媒体缓存并重新取址。
//
// 用在两种情况下：缓存下来的那份是错的版本（例如换源换成了伴奏），或者文件本身坏了。
// 光删缓存不够——播放器可能还握着内存里的 blob，所以删完要重新走一次 omni 取址并把
// 新地址写回 audioSrc，让它从头加载。

export const cacheCommands: CommandPaletteCommand[] = [
    defineCommand({
        id: 'clear-current-song-cache',
        group: 'playback',
        title: 'Clear cached audio and reload',
        description: 'Drop the cached copy of this song and fetch it again (wrong version, broken file)',
        keywords: ['clear cache', 'reload song', 'refetch', '缓存', '清除缓存', '重新加载', '重新取址'],
        icon: RefreshCw,
        isAvailable: context => Boolean(context?.shared.currentSong),
        execute: async (_input, context) => {
            const { currentSong, t, setStatusMsg } = context.shared;
            if (!currentSong) return false;
            try {
                const [{ getSongResourceCacheKey }, { getCachedAudioBlob, removeAudioBlob }, { omni }, { setAudioSrc }, { useAudioSettingsStore }] = await Promise.all([
                    import('../../../services/onlineMusic/resourceKeys'),
                    import('../../../services/audioCache'),
                    import('../../../services/onlineMusic/omni'),
                    import('../../../stores/usePlaybackStore'),
                    import('../../../stores/useAudioSettingsStore'),
                ]);

                const key = getSongResourceCacheKey('audio', currentSong);
                const cached = await getCachedAudioBlob(key);
                if (!cached) {
                    setStatusMsg({ type: 'info', text: t('ui.cacheEmpty', '这一首还没有缓存') });
                    return false;
                }

                await removeAudioBlob(key, cached.size);
                const quality = useAudioSettingsStore.getState().audioQuality;
                const source = await omni.getAudioSource(currentSong, quality);
                if (!source?.url) {
                    setStatusMsg({ type: 'error', text: t('ui.reloadFailed', '缓存已清除，但没有取到新地址') });
                    return false;
                }
                setAudioSrc(source.url);
                setStatusMsg({ type: 'success', text: t('ui.cacheCleared', '缓存已清除，已按同一版本重新加载') });
                return true;
            } catch (error) {
                console.error('[CommandPalette] Clearing the audio cache failed', error);
                setStatusMsg({ type: 'error', text: t('ui.reloadFailed', '缓存已清除，但没有取到新地址') });
                return false;
            }
        },
    }),
];
