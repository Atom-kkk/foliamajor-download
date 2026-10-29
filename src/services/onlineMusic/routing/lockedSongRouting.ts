import type { SongResult, UnifiedSong } from '../../../types';
import type { AudioQualityPreference, OmniAudioSource, OnlineMusicProvider, OnlineProviderId, ProviderSongAvailability } from '../../../types/onlineMusic';
import { getOnlineMusicProvider, getOnlineMusicProviderForSong, providerSupports } from '../providerRegistry';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import { isLockedSongRoutingEnabled, lockedSongFallbackProviderId } from '../custom/customSourceConfig';
import { XINGHAI_SOURCE_ID } from '../xinghai/xinghai';
import { isClipAudio } from '../audioProbe';
import { isDifferentVersion } from '../songVersionMatch';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';

// src/services/onlineMusic/routing/lockedSongRouting.ts
//
// 单曲级条件路由：内置源的歌**确定**因为权限放不出来时，把这一首的取址请求转给第三方源。
//
// 为什么放在 omni.getAudioSource 里：它是所有取址路径（直接播放、预取、会话恢复、窗口交接）的唯一
// 入口，缓存键、级别记录、ReplayGain、扩展钩子都在它后面。绕过它去改 restorePlaybackSource.ts
// 会把「缓存命中 / 竞态作废 / 预取」这些机制各写一遍，且只在恢复播放时生效。
//
// 三条纪律：
//   1. 只对**确定的权限锁定**切换。判据在 `isLockedForPlayback`：平台自己说 restricted 且没有可播档位，
//      或者平台把这首歌标成付费/会员（fee 1 / 4）而当前账号不是会员，或者灰歌（privilege.st < 0）且没有
//      可播档位。网络错误、超时、平台 5xx、下架（taken-down）都不算——那些照内置源原来的样子失败，
//      不会莫名其妙换一首别的录音回来。
//   2. 失败就退回原样：这里**永远不抛错**。找不到、连不上、格式不对，一律回 null，omni 接着走内置源原本
//      的路径（试听地址或报错），失败信息仍在原来的提示条上。
//   3. 换源只换「这一首的地址」，不换这首歌的身份：队列、历史、封面、歌词、收藏都还对着内置源的那一首。
//
// 匹配用元数据（标题 + 歌手 + 时长）在第三方源里搜一次，够像才用；不像就放弃，绝不猜。

/** 搜到的映射记多久。地址本身不缓存（第三方源的地址带时效），只缓存「哪一首对应哪一首」。 */
const MAPPING_TTL_MS = 30 * 60 * 1000;
/** 「这个源里没有这首歌」记多久：短一些，代价是过一会儿会再搜一次。 */
const NOT_FOUND_TTL_MS = 5 * 60 * 1000;
/** 时长差多少以内算同一首的同一版本。 */
const DURATION_TOLERANCE_MS = 8_000;
/** 相似度到这个分才敢用：标题对得上是最低要求，歌手或多或少的差异由分数吸收。 */
const MATCH_THRESHOLD = 85;

type Mapping =
    | { kind: 'found'; target: UnifiedSong; at: number }
    | { kind: 'missing'; at: number };

const mappings = new Map<string, Mapping>();

/**
 * 清掉「哪一首对哪一首」的记忆。
 *
 * 冷启动那次失败会把结果记成 `missing`（五分钟内直接返回 null）。调用方决定重试时必须先清掉，
 * 否则重试只是再读一遍「没找到」，等于没重试。
 */
export const forgetFallbackLookups = (): void => {
    mappings.clear();
};
const inFlight = new Map<string, Promise<UnifiedSong | null>>();

/** 测试与切源用：忘掉搜到过的对应关系。 */
export const forgetLockedSongMappings = (): void => {
    mappings.clear();
    inFlight.clear();
};

const normalizeText = (value: string): string => value
    .toLowerCase()
    // 括号里的版本说明（live / remix / 伴奏 / 电视剧主题曲…）不参与比较：同一首歌的各种版本标题常带这些。
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\-_.,!?'"`·、，。！？：；~]/g, '');

const artistNamesOf = (song: SongResult): string[] => (song.artists ?? [])
    .map(artist => normalizeText(artist.name || ''))
    .filter(Boolean);

/**
 * 相似度：标题是硬条件，歌手与时长调整分数。
 * 返回 0 表示不是同一首歌——调用方据此放弃，不拿「差不多」的录音顶上去。
 */
export const scoreSongMatch = (song: SongResult, candidate: SongResult): number => {
    const title = normalizeText(song.name || '');
    const candidateTitle = normalizeText(candidate.name || '');
    if (!title || !candidateTitle) return 0;

    let score = 0;
    if (title === candidateTitle) score += 70;
    else if (title.includes(candidateTitle) || candidateTitle.includes(title)) score += 40;
    else return 0;

    const wanted = artistNamesOf(song);
    const found = artistNamesOf(candidate);
    if (wanted.length > 0 && found.length > 0) {
        const shared = wanted.some(name => found.some(other => other.includes(name) || name.includes(other)));
        // 一个歌手都对不上，多半是同名不同曲：标题分数再高也不够。
        if (!shared) return 0;
        score += 25;
    }

    const a = song.durationMs;
    const b = candidate.durationMs;
    if (a > 0 && b > 0) {
        const delta = Math.abs(a - b);
        if (delta <= 3_000) score += 25;
        else if (delta <= DURATION_TOLERANCE_MS) score += 12;
        else if (delta > 30_000) score -= 25;
    }
    return Math.max(0, score);
};

const accountVipType = (providerId: string): number => {
    const vipType = useOnlineProviderAccountStore.getState().accounts[providerId]?.user?.vipType;
    return typeof vipType === 'number' && Number.isFinite(vipType) ? vipType : 0;
};

/**
 * 这一首是不是「确定放不出来，只能试听 / 报错」。
 *
 * 判据全部来自歌曲自身的字段与平台的可用性回答，不看这一次请求成没成功——请求失败有它自己的
 * 处理（重试、冷却、提示条），不该被这里改写成「换一首源里的歌」。
 */
export const isLockedForPlayback = (song: SongResult): boolean => {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return false;

    const provider = getOnlineMusicProviderForSong(song);
    const availability: ProviderSongAvailability = provider?.playback?.getAvailability?.(song) ?? { state: 'unknown' };
    // 下架（taken-down）不是权限问题：换源顶替一首已下架的歌，比报错更糟。
    if (availability.state === 'unavailable') return false;

    const privilege = song.privilege;
    const st = privilege?.st;
    const hasPlayableLevel = typeof privilege?.pl === 'number' && privilege.pl > 0;

    // 1) 平台自己说「受限」，且没有任何可播档位（pl 不大于 0）。
    if (availability.state === 'unknown' && availability.reason === 'restricted' && !hasPlayableLevel) return true;

    // 2) 平台把这首歌标成付费：fee 1 会员、fee 4 数字专辑。已经买过（payed === 1）的不算。
    const fee = song.fee;
    if ((fee === 1 || fee === 4) && privilege?.payed !== 1) {
        // 会员账号对 fee 1 是能放的：这时不该转走，否则会员反而被降级到第三方源。
        if (fee === 1 && accountVipType(ref.providerId) > 0) return false;
        return true;
    }

    // 3) 灰歌：st 为负（-200 已在上面按「下架」排除）且没有可播档位。
    if (typeof st === 'number' && st < 0 && !hasPlayableLevel) return true;

    return false;
};

/**
 * 兜底源，按顺序给出一串候选：
 *   1. `VITE_LOCKED_SONG_FALLBACK_PROVIDER` 指定的那个（默认 `custom`）；
 *   2. 星海——按原歌在自己平台上的 id 换地址，不搜索，最快也最稳；
 *   3. 酷我——按「标题 + 歌手」跨源找同一首，要一次搜索，放最后。
 *
 * 星海在前是实测结论：把它挪到酷我后面之后，每首歌都先多付一次搜索，原本能完整播放的歌
 * 反而退回试听。酷我只在星海给不出地址时才问。
 *
 * 星海换的是同一个 id 的音频，平台上个别本身错标的条目（音频是伴奏）它绕不开——那种情况
 * 在搜索列表里选另一条别的平台的同名结果即可。
 *
 * 歌本来就来自某条候选源时跳过它，不能兜回自己。
 */
const fallbackProviders = (song: SongResult): OnlineMusicProvider[] => {
    const ref = getPlaybackSourceRef(song);
    const configured = lockedSongFallbackProviderId();
    const candidateIds: OnlineProviderId[] = [configured];
    for (const id of [XINGHAI_SOURCE_ID, 'kuwo'] as OnlineProviderId[]) {
        if (!candidateIds.includes(id)) candidateIds.push(id);
    }

    const providers: OnlineMusicProvider[] = [];
    for (const providerId of candidateIds) {
        if (ref.kind === 'online' && ref.providerId === providerId) continue;
        const provider = getOnlineMusicProvider(providerId);
        if (!provider) continue;
        if (!providerSupports(provider, 'playback') || !provider.playback) continue;
        if (provider.getAvailability && !provider.getAvailability().configured) continue;
        providers.push(provider);
    }
    return providers;
};

/** 在兜底源里按元数据找同一首；找不到回 null。缓存只记「哪一首对哪一首」。 */
const findInFallback = async (provider: OnlineMusicProvider, song: SongResult): Promise<UnifiedSong | null> => {
    // 每个源各记各的映射：同一个 key 下星海与酷我对上的可能是不同的条目。
    const key = `${provider.id}:${getPlaybackSongKey(song)}`;
    const cached = mappings.get(key);
    if (cached) {
        const age = Date.now() - cached.at;
        if (cached.kind === 'found' && age < MAPPING_TTL_MS) return cached.target;
        if (cached.kind === 'missing' && age < NOT_FOUND_TTL_MS) return null;
        mappings.delete(key);
    }

    const running = inFlight.get(key);
    if (running) return await running;

    const search = (async (): Promise<UnifiedSong | null> => {
        const artist = (song.artists ?? []).map(entry => entry.name).filter(Boolean).join(' ');
        const query = [song.name, artist].filter(Boolean).join(' ').trim();
        if (!query) return null;

        const page = await provider.search!.searchSongs(query, 15, 0);
        let best: UnifiedSong | null = null;
        let bestScore = 0;
        for (const candidate of page.items) {
            // 同名不同版本（伴奏 / 现场 / 翻唱）在评分上几乎与原版持平，直接排除。
            // 只靠 scoreSongMatch 会把「我们俩 (伴奏)」当成原版放出来。
            if (isDifferentVersion(song.name, candidate.name)) continue;
            const score = scoreSongMatch(song, candidate);
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        if (!best || bestScore < MATCH_THRESHOLD) {
            mappings.set(key, { kind: 'missing', at: Date.now() });
            console.info(`[LockedRoute] 兜底源里没找到足够像的一首，保持内置源行为`, {
                song: song.name,
                bestScore,
            });
            return null;
        }
        mappings.set(key, { kind: 'found', target: best, at: Date.now() });
        console.info(`[LockedRoute] 这一首改由兜底源提供`, {
            song: song.name,
            via: provider.id,
            matched: best.name,
            score: bestScore,
        });
        return best;
    })();

    inFlight.set(key, search);
    try {
        return await search;
    } finally {
        inFlight.delete(key);
    }
};

/**
 * 内置源给不出完整版时，兜底源给的地址；其余一律 null（omni 继续走内置源原本的路）。
 * 绝不抛错：这里出任何问题都只是「这条捷径没走成」。
 *
 * `force`：调用方已经知道内置源没有完整版（没有地址，或只给了试听），不必再用权限标记判一次。
 * 下架的判断仍然保留——换源顶替一首已下架的歌，比报错更糟。
 */
export const resolveLockedSongAudio = async (
    song: SongResult,
    quality: AudioQualityPreference,
    options?: { force?: boolean },
): Promise<OmniAudioSource | null> => {
    if (!isLockedSongRoutingEnabled()) return null;
    try {
        if (options?.force) {
            const provider = getOnlineMusicProviderForSong(song);
            const availability: ProviderSongAvailability = provider?.playback?.getAvailability?.(song) ?? { state: 'unknown' };
            if (availability.state === 'unavailable') return null;
        } else if (!isLockedForPlayback(song)) {
            return null;
        }
        // 依次试每个候选：星海按 id 换（最不会串版本），失败或给片段再换酷我搜索。
        const providers = fallbackProviders(song);
        if (providers.length === 0) {
            console.info(`[Fallback] 没有可用的兜底源：${song.name}`);
            return null;
        }
        for (const provider of providers) {
            if (!provider.playback) continue;
            const target = providerSupports(provider, 'search') && provider.search
                ? await findInFallback(provider, song)
                : song;
            if (!target) {
                console.info(`[Fallback] 没找到同一首：${provider.id} / ${song.name}`);
                continue;
            }
            try {
                const source = await provider.playback.getAudioSource(target, quality);
                if (!source?.url || source.preview) {
                    console.info(`[Fallback] 没有完整地址：${provider.id}（preview=${Boolean(source?.preview)}）`);
                    continue;
                }
                // 片段也算失败：换下一个候选，而不是把 30 秒的文件交给播放器。
                const clipped = await isClipAudio(source.url, song.durationMs);
                console.info(`[Fallback] 候选结果：${provider.id} / ${song.name} clipped=${clipped} url=${source.url.slice(0, 60)}`);
                if (clipped) continue;
                return source;
            } catch (error) {
                // 这个候选没有地址，换下一个。
                console.warn(`[Fallback] 候选失败：${provider.id} — ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
        }
        console.info(`[Fallback] 所有候选都没给出完整版：${song.name}`);
        return null;
    } catch (error) {
        // 兜底源自己的失败不外溢：内置源原来会怎么做就还怎么做（试听地址 / 报错 / 重试）。
        console.warn('[LockedRoute] 兜底源没有给出地址，保持内置源行为', {
            song: song.name,
            error: error instanceof Error ? error.message : error,
        });
        return null;
    }
};
