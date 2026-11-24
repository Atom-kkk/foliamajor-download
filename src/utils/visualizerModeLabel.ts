// src/utils/visualizerModeLabel.ts
// Label lookup for a visualizer mode, kept out of the UI layer. Stores need the label only to
// format a notification; importing the registry would eagerly load every renderer and three.js.
// The registry registers the real resolver at start-up (it owns the live, mod-aware registry).

import type { VisualizerMode } from '../types';

export type VisualizerModeLabelResolver = (mode: VisualizerMode, t: (key: string) => string) => string;

// Until the registry registers, the mode id is an honest fallback: a notification may briefly
// show "classic" instead of its display name, but never a wrong or empty label.
let resolveLabel: VisualizerModeLabelResolver = mode => mode;

export const setVisualizerModeLabelResolver = (resolver: VisualizerModeLabelResolver): void => {
    resolveLabel = resolver;
};

export const resolveVisualizerModeLabel: VisualizerModeLabelResolver = (mode, t) => resolveLabel(mode, t);
