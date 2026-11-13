// src/types/playerControlSlots.ts
// 进度条胶囊右侧两个可自定义槽位的跨层合同。
//
// 只放 id、默认值和校验：store 需要它们来持久化，但不该为此依赖组件层的图标模块。
// 图标和 handler 解析在 src/components/floating-player/playerControlSlotActions.ts。

export type PlayerControlSlotActionId =
    | 'loop'
    | 'prev'
    | 'next'
    | 'shuffle'
    | 'like'
    | 'lyrics-timeline'
    | 'volume'
    | 'queue'
    | 'song-wall'
    | 'sleep-timer'
    | 'locate'
    | 'download';

export const PLAYER_CONTROL_SLOT_ACTION_IDS: readonly PlayerControlSlotActionId[] = [
    'loop',
    'prev',
    'next',
    'shuffle',
    'like',
    'lyrics-timeline',
    'volume',
    'queue',
    'song-wall',
    'sleep-timer',
    'locate',
    'download',
];

/** 主槽位仍是循环模式；副槽位默认给下载——它是会话里最常用的动作，原来那个位置放的是歌词时间轴。 */
export const DEFAULT_PLAYER_CONTROL_SLOT_PRIMARY: PlayerControlSlotActionId = 'loop';
export const DEFAULT_PLAYER_CONTROL_SLOT_SECONDARY: PlayerControlSlotActionId = 'download';

export const isPlayerControlSlotActionId = (value: unknown): value is PlayerControlSlotActionId => (
    typeof value === 'string' && (PLAYER_CONTROL_SLOT_ACTION_IDS as readonly string[]).includes(value)
);
