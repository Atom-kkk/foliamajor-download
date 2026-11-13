import { useEffect, useRef } from 'react';
import type { SongResult, VisualizerMode } from '../types';
import { pickRandomVisualizerMode } from '../utils/randomVisualizerModes';
import type { SetVisualizerModeOptions } from '../stores/useVisualizerSettingsStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// src/hooks/useRandomVisualizerMode.ts
//
// 两种随机：**每首歌换一次**（原有），或**每 N 句歌词换一次**（`linesPerSwitch > 0`）。
// 后者优先——开着逐句随机时还按歌切会互相打断。两种都只在保存的随机池（`modes`）里挑。

export function useRandomVisualizerMode({
    currentSong,
    enabled,
    visualizerMode,
    modes,
    setVisualizerMode,
    lineIndex = -1,
    linesPerSwitch = 0,
}: {
    currentSong: SongResult | null;
    enabled: boolean;
    visualizerMode: VisualizerMode;
    modes: readonly VisualizerMode[];
    setVisualizerMode: (mode: VisualizerMode, options?: SetVisualizerModeOptions) => void;
    /** 当前歌词行索引（-1 表示还没进人声）。 */
    lineIndex?: number;
    /** 每几句换一次；0 表示按歌换。 */
    linesPerSwitch?: number;
}) {
    const observedSongIdRef = useRef<string | null>(null);
    const pendingChoiceRef = useRef<{ songId: string | null; from: VisualizerMode; modes: readonly VisualizerMode[] } | null>(null);
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
        setVisualizerMode(pickRandomVisualizerMode(modes, visualizerMode), { notify: false });
    }, [enabled, lineIndex, linesPerSwitch, modes, perLines, setVisualizerMode, visualizerMode]);

    // 每首歌换一次（原来的行为）。逐句随机开着时让位。
    useEffect(() => {
        if (perLines) return;

        const songId = currentSong ? getPlaybackSongKey(currentSong) : null;
        if (!enabled) {
            observedSongIdRef.current = songId;
            pendingChoiceRef.current = null;
            return;
        }
        const songChanged = songId !== null && observedSongIdRef.current !== null && observedSongIdRef.current !== songId;
        if (songId !== null) observedSongIdRef.current = songId;

        // Keep one choice for the whole song. Enabling random or editing its pool only replaces a
        // style that is outside the selection; StrictMode and refreshed song metadata do not reroll.
        if (!songChanged && modes.includes(visualizerMode)) {
            pendingChoiceRef.current = null;
            return;
        }
        // StrictMode can replay this effect before the selected mode reaches the next render.
        const pending = pendingChoiceRef.current;
        if (pending?.songId === songId && pending.from === visualizerMode && pending.modes === modes) return;
        pendingChoiceRef.current = { songId, from: visualizerMode, modes };

        const nextMode = pickRandomVisualizerMode(modes, visualizerMode);
        if (nextMode !== visualizerMode) {
            setVisualizerMode(nextMode, { notify: false, preserveRandom: true });
        }
    }, [currentSong, enabled, modes, perLines, setVisualizerMode, visualizerMode]);
}
