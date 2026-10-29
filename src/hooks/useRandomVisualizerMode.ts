import { useEffect, useRef } from 'react';
import type { SongResult, VisualizerMode } from '../types';
import { VISUALIZER_REGISTRY } from '../components/visualizer/registry';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// src/hooks/useRandomVisualizerMode.ts
//
// 两种随机：**每首歌换一次**（原有），或**每 N 句歌词换一次**（`linesPerSwitch > 0`）。
// 后者优先——开着逐句随机时还按歌切会互相打断。
const pickOtherMode = (current: VisualizerMode): VisualizerMode => {
    const candidates = VISUALIZER_REGISTRY
        .map(entry => entry.mode)
        .filter(mode => mode !== current);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? current;
};

export function useRandomVisualizerMode({
    currentSong,
    enabled,
    visualizerMode,
    setVisualizerMode,
    lineIndex = -1,
    linesPerSwitch = 0,
}: {
    currentSong: SongResult | null;
    enabled: boolean;
    visualizerMode: VisualizerMode;
    setVisualizerMode: (mode: VisualizerMode, options?: { notify?: boolean }) => void;
    /** 当前歌词行索引（-1 表示还没进人声）。 */
    lineIndex?: number;
    /** 每几句换一次；0 表示按歌换。 */
    linesPerSwitch?: number;
}) {
    const observedSongIdRef = useRef<string | null>(null);
    const wasEnabledRef = useRef(enabled);
    const observedLineRef = useRef(-1);
    const lastSwitchLineRef = useRef(-1);
    const perLines = linesPerSwitch > 0;

    // 每 N 句换一次。
    useEffect(() => {
        if (!enabled || !perLines) return;
        if (lineIndex < 0 || lineIndex === observedLineRef.current) return;
        observedLineRef.current = lineIndex;
        // 第一句只记起点，不立刻换——刚开播就切一次会显得很突兀。
        if (lastSwitchLineRef.current < 0) {
            lastSwitchLineRef.current = lineIndex;
            return;
        }
        if (lineIndex - lastSwitchLineRef.current < linesPerSwitch) return;
        lastSwitchLineRef.current = lineIndex;
        setVisualizerMode(pickOtherMode(visualizerMode), { notify: false });
    }, [enabled, lineIndex, linesPerSwitch, perLines, setVisualizerMode, visualizerMode]);

    // 每首歌换一次（原来的行为）。逐句随机开着时让位。
    useEffect(() => {
        if (perLines) return;

        const songId = currentSong ? getPlaybackSongKey(currentSong) : null;
        const wasEnabled = wasEnabledRef.current;
        wasEnabledRef.current = enabled;

        if (!enabled) {
            observedSongIdRef.current = songId;
            return;
        }

        if (!wasEnabled) {
            observedSongIdRef.current = songId;
            return;
        }

        if (songId === null) {
            return;
        }

        if (observedSongIdRef.current === null) {
            observedSongIdRef.current = songId;
            return;
        }

        if (observedSongIdRef.current === songId) {
            return;
        }

        observedSongIdRef.current = songId;
        setVisualizerMode(pickOtherMode(visualizerMode), { notify: false });
    }, [currentSong, enabled, perLines, setVisualizerMode, visualizerMode]);
}
