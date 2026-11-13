import { Download } from 'lucide-react';
import { defineCommand } from '../commandFactories';
import type { CommandPaletteCommand, CommandPaletteContext } from '../types';

// src/components/command-palette/commands/downloadCommands.ts
// 下载当前歌曲。取地址复用 omni 的播放路径（含会员歌兜底），所以「能播的歌就能下」，而只有
// 试听片段的歌会被明确拒绝，不会存下一个 30 秒的文件。
//
// 下载服务按需 import：它会碰到 provider registry 与媒体缓存，而命令注册表要在 node 环境里被
// 单独加载（见 commands/index.ts 的断言与相关测试）。

const canDownload = (context?: CommandPaletteContext): boolean => {
    if (!context?.shared.currentSong) return false;
    return typeof window !== 'undefined' && Boolean(window.electron?.downloadAudio);
};

export const downloadCommands: CommandPaletteCommand[] = [
    defineCommand({
        id: 'download-current-song',
        group: 'playback',
        title: 'Download current song',
        description: 'Save this song as an audio file, from the same address the player uses',
        keywords: ['download', 'save audio', 'offline', 'save song', '下载', '下载歌曲', '保存到本地'],
        icon: Download,
        isAvailable: canDownload,
        execute: async (_input, context) => {
            const { currentSong, t, setStatusMsg } = context.shared;
            if (!currentSong) return false;
            try {
                const [{ downloadSong, DownloadError }, { useAudioSettingsStore }] = await Promise.all([
                    import('../../../services/downloads/downloadSong'),
                    import('../../../stores/useAudioSettingsStore'),
                ]);
                const result = await downloadSong(currentSong, useAudioSettingsStore.getState().audioQuality);
                if (result.canceled) return false;
                setStatusMsg({
                    type: 'success',
                    text: t('download.saved', 'Saved'),
                });
                return true;
            } catch (error) {
                console.error('[CommandPalette] Download failed', error);
                const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
                const text = code === 'no-full-version'
                    ? t('download.previewOnly', 'Only a preview clip is available for this song')
                    : t('download.failed', 'Download failed');
                setStatusMsg({ type: 'error', text });
                return false;
            }
        },
    }),
];
