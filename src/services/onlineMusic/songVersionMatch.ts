// src/services/onlineMusic/songVersionMatch.ts
//
// 「同名但不是一个版本」的判定：原版 vs 伴奏 / 现场 / 翻唱 / DJ 版。
//
// 播放兜底与下载都用它。评分（routing/lockedSongRouting.ts 的 scoreSongMatch）只看
// 「标题 + 歌手 + 时长」，而伴奏版与原创版的标题主体相同、时长常常只差几秒，分数一样高——
// 只靠分数会把伴奏当成原版放出来。
//
// 两道判据：
//   1. 候选标题里有版本词、原歌没有——「我们俩 (伴奏)」「少一点天分 现场版」；
//   2. 去掉括号后主体一致，但括号里的修饰不同。
//
// 放在这里而不是任一侧：两边都要用，且不能互相 import（downloads → routing 已经够绕了）。

const BRACKETED = /[（(\[【][^）)\]】]*[）)\]】]/g;

/** 标题里出现这些词，说明是另一个版本，不是同一段录音。 */
const VERSION_WORDS = /(live|现场|演唱会|音乐会|晚会|跨年|春晚|翻唱|cover|伴奏|instrumental|karaoke|消音|[^a-z]dj|remix|混音|重制|remaster|acoustic|不插电|demo|片段|剪辑|铃声|钢琴版|吉他版|纯音乐版)/i;

const stripBracketed = (value: string): string => value.replace(BRACKETED, '').replace(/\s+/g, '').trim();
/** 只看括号里的字，连括号本身一起归一：`(Live)` 与 `（Live）` 是同一个修饰。 */
const bracketedOf = (value: string): string => (value.match(BRACKETED) || [])
    .map(part => part.replace(/[（()）[\]【】]/g, '').toLowerCase())
    .join('')
    .replace(/\s+/g, '');

export const isDifferentVersion = (original: string, candidate: string): boolean => {
    if (!VERSION_WORDS.test(original) && VERSION_WORDS.test(candidate)) return true;
    const base = stripBracketed(original);
    if (!base || stripBracketed(candidate) !== base) return false;
    return bracketedOf(original) !== bracketedOf(candidate);
};
