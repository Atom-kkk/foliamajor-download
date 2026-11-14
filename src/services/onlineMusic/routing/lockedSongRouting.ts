import type { SongResult, UnifiedSong } from '../../../types';
import type { AudioQualityPreference, OmniAudioSource, OnlineMusicProvider, OnlineProviderId, ProviderSongAvailability } from '../../../types/onlineMusic';
import { getOnlineMusicProvider, getOnlineMusicProviderForSong, providerSupports } from '../providerRegistry';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import { isLockedSongRoutingEnabled, lockedSongFallbackProviderId } from '../custom/customSourceConfig';
import { XINGHAI_SOURCE_ID } from '../xinghai/xinghai';
import { isClipAudio, looksLikeClip, probeAudioDurationMs } from '../audioProbe';
import { isDifferentVersion } from '../songVersionMatch';
import { fetchWebArchiveAudio, isWebArchiveAvailable, searchWebArchive, type WebArchiveHit } from './webArchive';
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
 * 存档站「没有这首」记多久。预取与播放会连着问同一首（日志里 `[Prefetch] Failed to get audio
 * URL` 一次播一排），而每一步存档站查询是两三次 HTML 抓取——不记的话同一首会被抓上好几遍。
 */
const ARCHIVE_MISS_TTL_MS = 5 * 60 * 1000;
const archiveMisses = new Map<string, number>();

/**
 * 清掉「哪一首对哪一首」的记忆。
 *
 * 冷启动那次失败会把结果记成 `missing`（五分钟内直接返回 null）。调用方决定重试时必须先清掉，
 * 否则重试只是再读一遍「没找到」，等于没重试。
 */
export const forgetFallbackLookups = (): void => {
    mappings.clear();
    archiveMisses.clear();
};
const inFlight = new Map<string, Promise<UnifiedSong | null>>();

/** 测试与切源用：忘掉搜到过的对应关系。 */
export const forgetLockedSongMappings = (): void => {
    mappings.clear();
    inFlight.clear();
    archiveMisses.clear();
};

const normalizeText = (value: string): string => value
    .toLowerCase()
    // 括号里的版本说明（live / remix / 伴奏 / 电视剧主题曲…）不参与比较：同一首歌的各种版本标题常带这些。
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    // 「标题 - 副标题」这种写法（Spotify 常见：`有一種悲傷 - 電影《…》主題曲`）只比标题。
    // 只认两侧带空格的破折号，`Rock-Paper-Scissors` 这种连写的标题不受影响。
    .replace(/\s+[-–—]\s+.*$/, '')
    .replace(/[\s\-_.,!?'"`·、，。！？：；~]/g, '');

/**
 * 把歌名与歌手转成简体，用来**搜索**和**比较**。
 *
 * 平台之间的字形不一致很常见：Spotify 的曲目名是繁体（「說好的幸福呢」），网易云、酷我的曲库存的是
 * 简体（「说好的幸福呢」）。不做这一步时，标题直接对不上，`scoreSongMatch` 给 0 分，兜底整条链作废
 * ——2026-11-14 的日志里就是 `网易云里也没有足够像的一首 {"bestScore":0}`。
 *
 * opencc-js 是登记的重型包（D306：不许进首屏），所以这里懒加载：只有真的走到兜底匹配才付这份代价。
 * 加载失败（离线、包被裁掉）时退回原字形，不影响别的候选。
 */
let converter: Promise<((text: string) => string) | null> | null = null;
const traditionalToSimplified = (): Promise<((text: string) => string) | null> => {
    converter ??= import('opencc-js')
        .then(module => module.Converter({ from: 't', to: 'cn' }) as (text: string) => string)
        .catch(() => null);
    return converter;
};

/** 搜索与比较用的视图：歌名、歌手都转成简体，其余字段原样。只为单测导出。 */
export const simplifiedSubject = async (song: SongResult): Promise<SongResult> => {
    const convert = await traditionalToSimplified();
    if (!convert) return song;
    const name = convert(song.name ?? '');
    const artists = (song.artists ?? []).map(artist => ({ ...artist, name: convert(artist.name ?? '') }));
    return { ...song, name, artists };
};

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
        // 例外是同一个艺人在各平台的署名不同（A-Lin / 黄丽玲、G.E.M. 邓紫棋 / 邓紫棋）：
        // 只在**标题完全一致、长度差不超过 1 秒**时才认——那是同一个录音的强证据，翻唱不会同时满足
        // （「有一種悲傷」237 s 对翻唱 233/236 s 就不满足）。放过的这一档刚好够阈值（85）。
        if (!shared) {
            const sameLength = song.durationMs > 0 && candidate.durationMs > 0
                && Math.abs(song.durationMs - candidate.durationMs) <= 1_000;
            return sameLength && title === candidateTitle ? MATCH_THRESHOLD : 0;
        }
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
        // 搜索与比较都用简体视图：第三方曲库里同一首歌常是另一种字形（繁体「說好的幸福呢」）。
        const subject = await simplifiedSubject(song);
        const artist = (subject.artists ?? []).map(entry => entry.name).filter(Boolean).join(' ');
        const query = [subject.name, artist].filter(Boolean).join(' ').trim();
        if (!query) return null;

        const page = await provider.search!.searchSongs(query, 15, 0);
        let best: UnifiedSong | null = null;
        let bestScore = 0;
        for (const candidate of page.items) {
            // 同名不同版本（伴奏 / 现场 / 翻唱）在评分上几乎与原版持平，直接排除。
            // 只靠 scoreSongMatch 会把「我们俩 (伴奏)」当成原版放出来。
            if (isDifferentVersion(subject.name, candidate.name)) continue;
            const score = scoreSongMatch(subject, candidate);
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
 * 跨平台兜底：本平台、星海、酷我都拿不到时，去**别的平台**找同一首，再用星海换它的地址。
 *
 * 为什么需要这一步（2026-11-14 实测）：
 *   - 星海对 **QQ 源（tx）** 已经要认证：`{"code":403,"msg":"该音源仅对认证用户开放…"}`；
 *   - 酷我的曲库常常没有某些歌的原版（「偏爱 / 张芸京」20 条全是 Live / cover / 改编）；
 *   - 但同一首常在别家：网易云（星海 wy 免费）或酷狗（星海 kg 免费，且曲库最全——
 *     周杰伦《说好的幸福呢》网易云只有翻唱、酷狗有原版，换上来的文件 10.27 MB）。
 *
 * 所以最后按顺序试这两个平台：各自搜同曲 → 星海换址 → 实测不是片段。质量门槛与别的候选
 * 一样：版本排除 + 85 分 + 不是片段，绝不拿别的录音顶上去。歌本来就来自某一家时跳过那一家
 * （前面的星海候选已经换过一次）。
 */
const CROSS_PLATFORMS = ['netease', 'kugou'] as const;

/** 在某个平台的搜索结果里挑最像的一条；没有就像素返回 null。 */
const bestCandidate = (subject: SongResult, items: readonly UnifiedSong[], platformId: OnlineProviderId): { song: UnifiedSong; score: number } | null => {
    let best: UnifiedSong | null = null;
    let bestScore = 0;
    for (const candidate of items) {
        if (candidate.sourceRef.kind !== 'online' || candidate.sourceRef.providerId !== platformId) continue;
        if (isDifferentVersion(subject.name, candidate.name)) continue;
        const score = scoreSongMatch(subject, candidate);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best && bestScore >= MATCH_THRESHOLD ? { song: best, score: bestScore } : null;
};

const bridgeThroughOtherPlatform = async (song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> => {
    const origin = getPlaybackSourceRef(song);
    const xinghai = getOnlineMusicProvider(XINGHAI_SOURCE_ID);
    if (!xinghai?.playback?.getAudioSource) return null;

    // 搜索与比较都用简体视图：Spotify 给的是繁体曲目名（「說好的幸福呢」），曲库存的是简体。
    const subject = await simplifiedSubject(song);
    const artist = (subject.artists ?? []).map(entry => entry.name).filter(Boolean).join(' ');
    const query = [subject.name, artist].filter(Boolean).join(' ').trim();
    if (!query) return null;

    for (const platformId of CROSS_PLATFORMS) {
        // 歌本来就来自这一家：前面的星海候选已经按它自己的 id 换过一次，不必再搜。
        if (origin.kind === 'online' && origin.providerId === platformId) continue;
        const provider = getOnlineMusicProvider(platformId);
        if (!provider?.search?.searchSongs) continue;
        if (provider.getAvailability && !provider.getAvailability().configured) continue;
        try {
            const page = await provider.search.searchSongs(query, 15, 0);
            const found = bestCandidate(subject, page.items, platformId);
            if (!found) {
                console.info('[Fallback] 这个平台里没有足够像的一首', { song: song.name, query, platform: platformId });
                continue;
            }
            const source = await xinghai.playback.getAudioSource(found.song, quality);
            if (!source?.url || source.preview) continue;
            const expectedMs = found.song.durationMs > 0 ? found.song.durationMs : song.durationMs;
            if (await isClipAudio(source.url, expectedMs, { priority: true })) continue;
            console.info('[Fallback] 改由同曲换址', {
                song: song.name,
                via: platformId,
                matched: found.song.name,
                score: found.score,
            });
            return source;
        } catch (error) {
            console.warn('[Fallback] 同曲换址失败，换下一个平台', { platform: platformId, error });
        }
    }
    return null;
};

/** 存档站给的时长与这首歌差多少还认。平台之间报的长度常有 1~3 秒差，这里留得宽一些。 */
const ARCHIVE_DURATION_TOLERANCE_MS = 15_000;

/** 存档站里带这些字样的条目是剪辑/试听/预告，长度对不上，直接不要。 */
const CLIP_TITLE = /片段|试听|試聽|抢先|30\s*秒|一分钟|一分钟试听/i;

/** 只给比较用：`scoreSongMatch` 读歌名、歌手、时长三样，别的一概不看。 */
const asCandidate = (hit: WebArchiveHit): SongResult => ({
    name: hit.title,
    artists: hit.artist ? [{ id: '', name: hit.artist }] : [],
    durationMs: 0,
} as unknown as SongResult);

/**
 * 最后一步：网页存档站。
 *
 * 前面四步都依赖「三家曲库里有这首」这件事。有些歌就是没有——「偏爱 / 张芸京」在酷我搜出 20 条
 * 全是 Live / cover / 改编，「说好的幸福呢」在网易云前 15 条全是翻唱。存档站的曲库来自用户上传，
 * 跟平台版权无关，这几首它第一条就是原版（2026-11-14 实测：256.8 s / 213.0 s，完整 mp3）。
 *
 * 代价与门槛：
 *   - 一次搜索 + 一次取址要两三个 HTTP 请求，所以放在**最后**，只有前面全失败才走。
 *   - 文件是用户上传的，同名不同录音比平台多，所以除了标题/歌手/版本判据，还要**实测时长**：
 *     与这首歌差超过 15 秒就不要——翻唱、Live、剪辑都过不了这一关。
 *   - 只给 128 kbps，`quality` 报 `standard`（报高了会被记成降级回退）。
 */
const lookupArchive = async (song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> => {
    // 搜索与比较都用简体：存档站与曲库一样是简体，而平台可能给繁体。
    const subject = await simplifiedSubject(song);
    const artist = (subject.artists ?? []).map(entry => entry.name).filter(Boolean).join(' ');
    const query = [subject.name, artist].filter(Boolean).join(' ').trim();
    if (!query) return null;

    const hits = await searchWebArchive(query);
    if (hits.length === 0) {
        console.info('[Fallback] 存档站没有搜到', { song: song.name, query });
        return null;
    }

    let bestScore = 0;
    const ranked: { hit: WebArchiveHit; score: number }[] = [];
    for (const hit of hits) {
        // 搜索页里常混着同名剪辑：「为你写的歌 (30秒片段)」归一化后和原版一模一样，得按原文挡。
        if (CLIP_TITLE.test(hit.title)) continue;
        if (isDifferentVersion(subject.name, hit.title)) continue;
        const score = scoreSongMatch(subject, asCandidate(hit));
        if (score > bestScore) bestScore = score;
        if (score >= MATCH_THRESHOLD) ranked.push({ hit, score });
    }
    if (ranked.length === 0) {
        console.info('[Fallback] 存档站里没有足够像的一首', { song: song.name, query, bestScore });
        return null;
    }
    ranked.sort((a, b) => b.score - a.score);

    // 只试前两条：每条要两次请求，再多也不会有新结果，只会拖长「放不出来」的等待。
    for (const { hit, score } of ranked.slice(0, 2)) {
        const source = await fetchWebArchiveAudio(hit.id);
        if (!source?.url) continue;
        const expectedMs = song.durationMs > 0 ? song.durationMs : 0;
        const measured = await probeAudioDurationMs(source.url, undefined, { priority: true });
        if (measured !== null) {
            if (looksLikeClip(measured, expectedMs)) {
                console.info('[Fallback] 存档站给的是一段', { song: hit.title, measured, expectedMs });
                continue;
            }
            if (expectedMs > 0 && Math.abs(measured - expectedMs) > ARCHIVE_DURATION_TOLERANCE_MS) {
                console.info('[Fallback] 存档站给的是别的录音', { song: hit.title, measured, expectedMs });
                continue;
            }
        } else if (await isClipAudio(source.url, expectedMs, { priority: true })) {
            continue;
        }
        console.info('[Fallback] 改由存档站提供', {
            song: song.name,
            matched: hit.title,
            artist: hit.artist,
            score,
            measured,
        });
        return source;
    }
    console.info('[Fallback] 存档站的候选都不合格', { song: song.name, query, tried: Math.min(ranked.length, 2) });
    return null;
};

/**
 * 最后一步的入口：查一次，没查到就把「没有这首」记五分钟。
 *
 * 记忆只针对「没查到」：查到了也不能缓存地址——存档站的地址是一次性签名，存下来只会放不出来。
 */
export const tryWebArchive = async (song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> => {
    if (!isWebArchiveAvailable()) return null;
    const key = getPlaybackSongKey(song);
    const missedAt = archiveMisses.get(key);
    if (missedAt !== undefined && Date.now() - missedAt < ARCHIVE_MISS_TTL_MS) return null;
    const found = await lookupArchive(song, quality);
    if (found) {
        archiveMisses.delete(key);
        return found;
    }
    archiveMisses.set(key, Date.now());
    return null;
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
                const clipped = await isClipAudio(source.url, song.durationMs, { priority: true });
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
        // 最后一步：别的平台的原版常常拿不到（星海对 QQ 源要认证、酷我可能没有原版），
        // 但同一首在网易云有、而星海换网易云的地址是免费的。
        try {
            const crossed = await bridgeThroughOtherPlatform(song, quality);
            if (crossed) return crossed;
        } catch (error) {
            console.warn('[Fallback] 跨平台同曲换址失败，保持内置源行为', error);
        }
        // 更后面一步：网页存档站。三家曲库都没有的歌，最后只能到它这里找。
        try {
            const archived = await tryWebArchive(song, quality);
            if (archived) return archived;
        } catch (error) {
            console.warn('[Fallback] 存档站这一路失败，保持内置源行为', error);
        }
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
