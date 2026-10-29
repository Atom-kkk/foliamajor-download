import type { SongResult, UnifiedSong } from '../../types';
import type {
    AudioQualityPreference,
    LoginStep,
    MediaId,
    OmniAudioSource,
    OmniChorusRange,
    OmniCollection,
    OmniExploreItemsPage,
    OmniExplorePage,
    OmniHistoryEntry,
    OmniLyricsResult,
    OmniPage,
    OmniPlaybackReport,
    OmniProviderCapabilities,
    OmniProviderId,
    OmniProviderSummary,
    OmniSongAvailability,
    OmniSongReplacement,
    OmniUser,
    OnlineAuthProvider,
    OnlineFailureOperation,
    OnlineMusicProvider,
    PersonalFmRequestOptions,
    ProviderCatalogEntityKind,
    ProviderLikedSongIds,
    LoginDiagnosticLine,
    LoginLocalService,
    LoginMethod,
    LoginSelfCheckResult,
    ProviderNotice,
    LoginState,
    LoginTexts,
    ProviderMark,
} from '../../types/onlineMusic';
import { resolveProviderLyricsChorus } from '../../utils/lyrics/chorusResolver';
import { DEFAULT_ONLINE_PROVIDER_ID, OnlineProviderError } from '../../types/onlineMusic';
import { useOnlineProviderAccountStore } from '../../stores/useOnlineProviderAccountStore';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { toSafePlaybackUrl } from '../../utils/appPlaybackHelpers';
import { saveSongReplayGain } from './resourceCache';
import {
    getOnlineMusicProvider,
    getOnlineMusicProviderForSong,
    getOnlineMusicProviderRegistryVersion,
    listOnlineMusicProviders,
    providerSupports,
    requireOnlineMusicProvider,
    subscribeOnlineMusicProviderRegistry,
} from './providerRegistry';
import { saveProviderAccountSnapshot } from './providerAccountCache';
import { applyOmniAudioHook, applyOmniLyricsHook } from '../hostExtensionHooks';
import { createLikePresses } from '../../utils/likePresses';
import type { LikePress, LikePresses } from '../../utils/likePresses';
import { noteLoginFailure } from './login/loginFailureCase';
import { noteOnlineFailure } from './failure/onlineFailureCase';
import { diagnosticLine } from './login/loginDiagnosticReport';
import { errorFields, errorMessage } from '../../utils/errorText';
import { keptAfterRead } from './account/keptAfterRead';
import type { AccountRead } from './account/keptAfterRead';
import { createLikedChecks } from './account/likedChecks';
import type { SongInPlay } from './account/likedChecks';
import { createAccountMoments } from './account/readMoments';
import type { AccountMoment } from './account/readMoments';
import { createAccountReads } from './account/accountRead';
import type { AccountReadOutcome, AccountReadReason } from './account/accountRead';
import { forgetFallbackLookups, resolveLockedSongAudio } from './routing/lockedSongRouting';
import { isClipAudio } from './audioProbe';
import { isGuestUser } from './guest/guestAccess';
import { lockedSongFallbackProviderId } from './custom/customSourceConfig';

// src/services/onlineMusic/omni.ts
// Online Music Network Interface (Omni) - a unified interface for interacting with multiple online music providers.


type PageInput = { limit: number; offset: number };

// The quality levels, lowest first.
const AUDIO_QUALITY_LEVELS: readonly AudioQualityPreference[] = ['standard', 'high', 'ultra', 'lossless', 'hires'];
// A provider that lists none of its own tells these four apart. 'ultra' is not among them: it
// is a level only for a provider that lists it, so no other provider is ever asked at it.
const UNLISTED_AUDIO_QUALITY_LEVELS: readonly AudioQualityPreference[] = ['standard', 'high', 'lossless', 'hires'];
const audioQualityLevelsOf = (providerId: OmniProviderId): readonly AudioQualityPreference[] => {
    const listed = getOnlineMusicProvider(providerId)?.playback?.audioQualityLevels;
    return listed?.length ? AUDIO_QUALITY_LEVELS.filter(level => listed.includes(level)) : UNLISTED_AUDIO_QUALITY_LEVELS;
};
// The level a provider is asked for under the stored preference, which is one value for every
// provider: the preference itself where the provider lists it, else the nearest level it lists
// at or below (its lowest where it lists none below).
const audioQualityFor = (providerId: OmniProviderId, preference: AudioQualityPreference): AudioQualityPreference => {
    const levels = audioQualityLevelsOf(providerId);
    const rank = AUDIO_QUALITY_LEVELS.indexOf(preference);
    return [...levels].reverse().find(level => AUDIO_QUALITY_LEVELS.indexOf(level) <= rank) ?? levels[0];
};

// What is known of each URL handed out by `getAudioSource`, newest last: the level it was asked for
// at, and whether its provider said it plays a preview clip of the song. The media cache asks by URL
// when it saves a song's bytes: the preference may have moved since the URL was fetched, and the URL
// is where the bytes came from. Playback asks by URL whether what it plays is a clip, wherever it
// got the URL from (the prefetch pass, or its own request). In memory and bounded; a URL that has
// dropped out is of an unknown level and not known to be a clip.
const AUDIO_SOURCE_LEVEL_LIMIT = 200;
type HandedOutAudioSource = { level: AudioQualityPreference; preview: boolean };
const audioSourceLevels = new Map<string, HandedOutAudioSource>();
// One spelling per URL: the form playback holds (`toSafePlaybackUrl`), written as the URL parser
// writes it - a deck that has played out reports its element's `currentSrc`, which is that form.
const audioSourceLevelKey = (url: string): string => {
    const playbackUrl = toSafePlaybackUrl(url) ?? url;
    try {
        return new URL(playbackUrl).href;
    } catch {
        return playbackUrl;
    }
};
const noteAudioSourceLevel = (url: string, handedOut: HandedOutAudioSource): void => {
    const key = audioSourceLevelKey(url);
    audioSourceLevels.delete(key);
    audioSourceLevels.set(key, handedOut);
    if (audioSourceLevels.size > AUDIO_SOURCE_LEVEL_LIMIT) {
        const oldestKey = audioSourceLevels.keys().next().value;
        if (oldestKey !== undefined) audioSourceLevels.delete(oldestKey);
    }
};

const activeProviderId = (): OmniProviderId => {
    const storedProviderId = useOnlineProviderAccountStore.getState().activeProviderId;
    // A persisted selection can outlive its provider when switching builds or branches.
    return getOnlineMusicProvider(storedProviderId) ? storedProviderId : DEFAULT_ONLINE_PROVIDER_ID;
};

const activeProvider = () => requireOnlineMusicProvider(activeProviderId());

const providerForSong = (song: SongResult) => {
    const provider = getOnlineMusicProviderForSong(song);
    if (!provider) throw new OnlineProviderError('unsupported', 'Song is not owned by an online provider');
    return provider;
};

const providerForCollection = (collection: OmniCollection) => requireOnlineMusicProvider(collection.providerId);

const unsupported = (providerId: OmniProviderId, capability: string): never => {
    throw new OnlineProviderError('unsupported', `${capability} is not supported by ${providerId}`, providerId);
};

// Runs one step of a sign-in. Where the step throws, what the provider knows of the failure
// (`describeLoginFailure`) is left on the error for the sign-in dialog (login/loginFailureCase.ts);
// the error itself goes on as it is, also when the provider's function throws.
const runLoginStep = async <T>(auth: OnlineAuthProvider, step: LoginStep, run: () => Promise<T>): Promise<T> => {
    try {
        return await run();
    } catch (error) {
        try {
            noteLoginFailure(error, auth.describeLoginFailure?.(step, error));
        } catch (describeError) {
            console.warn('[Omni] describeLoginFailure threw; the sign-in error goes on without a note', { step }, describeError);
        }
        throw error;
    }
};

// Runs a request for a song's audio or a collection's tracks. Where it throws, what the provider
// knows of the failure (`describeFailure`) is left on the error for the message that tells of it
// (failure/onlineFailureCase.ts); the error itself goes on as it is, also when the provider's function throws.
const runRequest = async <T>(provider: OnlineMusicProvider, operation: OnlineFailureOperation, run: () => Promise<T>): Promise<T> => {
    try {
        return await run();
    } catch (error) {
        try {
            noteOnlineFailure(error, provider.describeFailure?.(operation, error));
        } catch (describeError) {
            console.warn('[Omni] describeFailure threw; the error goes on without a note', { operation }, describeError);
        }
        throw error;
    }
};

const emptyPage = <T>(offset: number): OmniPage<T> => ({ items: [], hasMore: false, nextOffset: offset });

// 点赞状态改完要落盘：只更内存的话，重启后靠快照 hydration 的那一帧会恢复旧心形，
// 后台刷新再失败就一直是旧的。
const persistProviderLikedSongIds = async (providerId: OmniProviderId): Promise<void> => {
    const account = useOnlineProviderAccountStore.getState().accounts[providerId];
    if (!account?.user) return;
    try {
        await saveProviderAccountSnapshot(providerId, {
            user: account.user,
            collections: account.collections || [],
            likedSongIds: account.likedSongIds || [],
        });
    } catch (error) {
        // 落盘失败不能把一次成功的 mutation 变成失败，下一次刷新会补上。
        console.warn('[Omni] Failed to persist liked songs after a like mutation', { providerId }, error);
    }
};

// The presses on hearts (likePresses.ts), one provider's songs apart from another's. What is
// wanted for a song whose request is not settled goes into the account store (`wantedLikes`),
// where `isSongLiked` reads it and the screen follows it.
const likePressesByProvider = new Map<OmniProviderId, LikePresses>();
const likePressesOf = (providerId: OmniProviderId): LikePresses => {
    let presses = likePressesByProvider.get(providerId);
    if (!presses) {
        presses = createLikePresses({
            name: providerId,
            onChange: wantedLikes => useOnlineProviderAccountStore.getState().updateAccount(providerId, { wantedLikes }),
        });
        likePressesByProvider.set(providerId, presses);
    }
    return presses;
};

// One like request to the song's provider. Taken, the account's liked ids follow it; refused,
// they stay as they are and the error goes up. `signal`: see `LikeSend` in likePresses.ts.
const sendSongLike = async (
    provider: OnlineMusicProvider,
    song: SongResult,
    source: { providerId: OmniProviderId; mediaId: MediaId },
    liked: boolean,
    signal: AbortSignal,
): Promise<void> => {
    if (!provider.mutations?.likeSong) return unsupported(provider.id, 'likes');

    const songKey = String(source.mediaId);
    const account = useOnlineProviderAccountStore.getState().accounts[source.providerId];
    // Whether the account is still the one the request is made for: an answer that comes after
    // it was cleared or changed writes nothing into the account that is there then. A request
    // sent before the account was named (app start: the session is there, its user is read a
    // moment later) belongs to whoever is named when it is answered.
    const sentAs = account?.user?.id;
    const isSameAccount = (): boolean => (
        sentAs === undefined || sentAs === null
        || String(useOnlineProviderAccountStore.getState().accounts[source.providerId]?.user?.id) === String(sentAs)
    );

    // 失败时点赞状态保持原样，错误往上抛给调用方。
    await provider.mutations.likeSong(song, liked);

    // An answer to a request that was given up (the heart was put back and the run ended as
    // failed) writes no like: the next whole read of the liked songs says what the provider
    // holds.
    if (signal.aborted) {
        console.log(`[Like] ${source.providerId}:${songKey} answered after the request was given up; nothing is written`);
        return;
    }
    // An answer for an account that was signed out or changed meanwhile writes nothing into the
    // account that is there now. The run still ends as taken: the provider did take it.
    if (!isSameAccount()) {
        console.log(`[Like] ${source.providerId}:${songKey} answered after its account left; nothing is written`);
        return;
    }

    // 成功之后写 likedSongIds：直接调 likeSong 的入口（例如"我喜欢"网格里删歌）也必须让账号缓存
    // 跟着走，否则和 toggleSongLike 两个入口语义不同。
    //
    // @note 网易云不再是例外（2026-10-09）：它的点赞集合原来由 useNeteaseLibrary 的本地 state 当家，
    // 再单向镜像到这个 store，所以从 GridView 直接调用这里时网易云的播放器心形不会跟着变。现在那份
    // state 已经挪进这个 store，useNeteaseLibrary 不再交出点赞的集合，播放器的心形直接读这个 store
    // （usePlayerPanelModel），这里写完心形就跟着变。
    const latest = useOnlineProviderAccountStore.getState().accounts[source.providerId];
    const likedSongIds = (latest?.likedSongIds || []).filter(id => String(id) !== songKey);
    useOnlineProviderAccountStore.getState().updateAccount(source.providerId, {
        likedSongIds: liked ? [...likedSongIds, source.mediaId] : likedSongIds,
    });
    await persistProviderLikedSongIds(source.providerId);
};

/** A read of an account's liked songs under way: the account's read, a moment's, or the liked list's own (`beginLikedListRead`). */
export interface LikedListRead extends AccountRead {
    providerId: OmniProviderId;
}

// How many reads of each provider's liked songs have begun, and the number of the newest whole
// one that was applied: an answer that comes after the whole answer of a read begun later is
// dropped. A read that was not whole only added, so it holds no other read back.
const likedReadsBegun = new Map<OmniProviderId, number>();
const likedReadsApplied = new Map<OmniProviderId, number>();

const beginLikedRead = (providerId: OmniProviderId, userId: MediaId): LikedListRead => {
    const order = (likedReadsBegun.get(providerId) ?? 0) + 1;
    likedReadsBegun.set(providerId, order);
    return { providerId, userId, beganAt: Date.now(), order };
};

// The end of a read of an account's liked songs: what was read meets what the listener pressed by
// the one rule (account/keptAfterRead.ts), and the account store is written where that changes
// what is held. Says whether it was applied, whether the liked ids changed (saving the snapshot is
// the caller's), and whether the account now holds what the answer held: it was applied and no
// song kept what Folia held because it was pressed. `notLiked`: the answer is a check of some
// songs (account/likedChecks.ts), and these it found not liked.
const applyLikedRead = (
    read: LikedListRead,
    answer: ProviderLikedSongIds,
    notLiked?: MediaId[],
): { applied: boolean; changed: boolean; alike: boolean } => {
    const account = useOnlineProviderAccountStore.getState().accounts[read.providerId];
    const held = account?.likedSongIds || [];
    const what = notLiked
        ? `hearts of ${answer.ids.length + notLiked.length} songs in play checked (${answer.ids.length} liked)`
        : `liked songs read (${answer.whole ? 'whole' : 'not whole'}, ${answer.ids.length} ids)`;
    const kept = keptAfterRead({
        read,
        answer,
        notKept: notLiked,
        held,
        signedInUserId: account?.user?.id,
        newestApplied: likedReadsApplied.get(read.providerId) ?? 0,
        touchedSince: likePressesOf(read.providerId).touchedSince,
    });
    if ('refused' in kept) {
        console.log(`[Like] ${read.providerId}: ${what} not applied: ${kept.refused}; the liked songs stay as they were`);
        return { applied: false, changed: false, alike: false };
    }
    if (answer.whole) likedReadsApplied.set(read.providerId, read.order);
    console.log(`[Like] ${read.providerId}: ${what} applied: ${kept.added} added, ${kept.removed} removed, ${kept.pressed.size} kept because pressed`);

    const changed = kept.added > 0 || kept.removed > 0;
    const alike = kept.pressed.size === 0;
    if (changed) useOnlineProviderAccountStore.getState().updateAccount(read.providerId, { likedSongIds: kept.ids });
    return { applied: true, changed, alike };
};

// Where a platform's liked list was not read to the end, the hearts of the songs in play are
// asked of it (account/likedChecks.ts), and settled by the one rule above.
const likedChecks = createLikedChecks({
    signedIn: providerId => useOnlineProviderAccountStore.getState().accounts[providerId]?.user?.id ?? null,
    asker: providerId => {
        const library = getOnlineMusicProvider(providerId)?.library;
        return library?.areSongsLiked ? ids => library.areSongsLiked!(ids) : null;
    },
    beginLikedRead,
    applyLikedCheck: (read, liked, notLiked) => {
        if (applyLikedRead(read, { ids: liked, whole: false }, notLiked).changed) void persistProviderLikedSongIds(read.providerId);
    },
});

// A read of the liked ids, by the adapter (`getLikedSongIds`) or of the liked list from its first
// page (`endLikedListRead`), settled by the one rule; whether it was whole decides whether the
// songs in play are checked (account/likedChecks.ts).
const applyLikedIdsRead = (read: LikedListRead, answer: ProviderLikedSongIds): { changed: boolean; alike: boolean } => {
    const ended = applyLikedRead(read, answer);
    if (ended.applied) likedChecks.likedRead(read.providerId, read.userId, answer.whole);
    return ended;
};

// Reads an account's liked song ids whole from its provider. What was read meets what the
// listener pressed meanwhile, and a newer account, by the one rule, and the snapshot is saved
// where the liked ids changed. Rejects where the read failed: no liked id is changed then.
// Answers whether the account now holds what the answer held (see `applyLikedRead`).
// `countedEmpty`: the platform's count of the list, asked just before, was 0 (account/readMoments.ts).
const readLikedSongIds = async (providerId: OmniProviderId, userId: MediaId, countedEmpty = false): Promise<boolean> => {
    const read = { ...beginLikedRead(providerId, userId), countedEmpty };
    const answer = await omni.getProviderLikedSongIds(providerId, userId);
    const { changed, alike } = applyLikedIdsRead(read, answer);
    if (changed) await persistProviderLikedSongIds(providerId);
    return alike;
};

// The reads of an account from its platform (account/accountRead.ts): who is signed in, their
// playlists, their liked ids. The liked ids it reads are settled by the one rule above.
const accountReads = createAccountReads({
    beginLikedRead,
    applyLikedRead: applyLikedIdsRead,
    forgetLikePresses: providerId => likePressesByProvider.get(providerId)?.forget(),
    // Only spans of time are measured: a clock that is set back must not hold the reads off.
    now: () => performance.now(),
});

// The moments at which an account's liked songs may have been changed in its platform's own app
// (account/readMoments.ts decides what is asked and read then). The seam to the platforms is the
// two entries below, the same for every platform: the adapter's own count of its liked list, and
// the read of the liked ids. A moment that falls into a read of the account under way joins its
// liked part and reads no second time.
const accountMoments = createAccountMoments({
    account: providerId => {
        const account = useOnlineProviderAccountStore.getState().accounts[providerId];
        const userId = account?.user?.id;
        if (!account || userId === undefined || userId === null) return null;
        return { userId, likedHeld: (account.likedSongIds || []).length };
    },
    likedCount: (providerId, userId) => getOnlineMusicProvider(providerId)?.library?.getLikedSongCount?.(userId),
    readLikedWhole: (providerId, userId, countedEmpty) => accountReads.likedOfReadUnderWay(providerId) ?? readLikedSongIds(providerId, userId, countedEmpty),
    // Only spans of time are measured: a clock that is set back must not hold the checks off.
    now: () => performance.now(),
});

let activeRequestGeneration = 0;

// Rejects late active-provider responses after an account switch transaction begins.
const withActiveProvider = async <T>(run: (provider: OnlineMusicProvider) => Promise<T>): Promise<T> => {
    const providerId = activeProviderId();
    const generation = activeRequestGeneration;
    const result = await run(requireOnlineMusicProvider(providerId));
    if (generation !== activeRequestGeneration || providerId !== activeProviderId()) {
        throw new DOMException('Active online provider changed', 'AbortError');
    }
    return result;
};

/** 聚合搜索最多再问几个源。每个都要一次网络请求，多问一个就多等一截。 */
const AGGREGATE_MAX_EXTRA_SOURCES = 3;
/** 一次聚合搜索的预算：等最慢的那个源，超过就当作它没回答。 */
const AGGREGATE_SEARCH_TIMEOUT_MS = 3_500;
/** 除活跃源外，按这个顺序挑：先挑不需要登录、地址也稳的。 */
const AGGREGATE_SOURCE_ORDER: OmniProviderId[] = ['kuwo', 'qq', 'kugou', 'bodian', 'ytm', 'spotify'];

const withSearchTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('search timed out')), ms);
    promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
    );
});

/** 去重键：标题与歌手去掉空白与标点，大小写不敏感。 */
const searchResultKey = (song: SongResult): string => {
    const name = String(song.name ?? '').toLowerCase().replace(/[\s()（）[\]【】\-_.·]/g, '');
    const artists = (song.artists ?? []).map(entry => entry.name).join('').toLowerCase().replace(/\s/g, '');
    return `${name}|${artists}`;
};

/**
 * 聚合搜索：活跃源 + 最多三个其它可搜索源，并发查，合并去重。
 *
 * 去重时**保留活跃源那一条**——它的封面与元数据最全，界面不该因为聚合而掉封面。
 * 同一首歌在别的源上能不能播完整版，由取址时的兜底路由负责（`routing/lockedSongRouting.ts`），
 * 不在这里换条目。
 */
/** 同一句查询 5 秒内复用：搜索框边打边搜时，别为同一个词把每个源都再问一遍。 */
const AGGREGATE_SEARCH_CACHE_MS = 5_000;
let lastAggregateSearch: { query: string; limit: number; at: number; page: OmniPage<UnifiedSong> } | null = null;

const aggregateSearch = async (query: string, page: PageInput): Promise<OmniPage<UnifiedSong>> => {
    const cached = lastAggregateSearch;
    if (cached && cached.query === query && cached.limit === page.limit && Date.now() - cached.at < AGGREGATE_SEARCH_CACHE_MS) {
        return cached.page;
    }

    const active = requireOnlineMusicProvider(activeProviderId());
    const generation = activeRequestGeneration;

    const extras = AGGREGATE_SOURCE_ORDER
        .filter(id => id !== active.id)
        .map(id => getOnlineMusicProvider(id))
        .filter((provider): provider is OnlineMusicProvider => Boolean(provider))
        .filter(provider => providerSupports(provider, 'search') && Boolean(provider.search))
        .filter(provider => provider.getAvailability?.().configured !== false)
        .slice(0, AGGREGATE_MAX_EXTRA_SOURCES);

    const sources = [active, ...extras];
    const settled = await Promise.allSettled(sources.map(provider => withSearchTimeout(
        provider.search!.searchSongs(query, page.limit, 0),
        AGGREGATE_SEARCH_TIMEOUT_MS,
    )));

    // 账号切换期间到的结果不要（和单源路径同一个约定）。
    if (generation !== activeRequestGeneration || active.id !== activeProviderId()) {
        throw new DOMException('Active online provider changed', 'AbortError');
    }

    const merged: UnifiedSong[] = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') merged.push(...result.value.items);
    }

    const isFromActive = (song: UnifiedSong) => song.sourceRef.kind === 'online' && song.sourceRef.providerId === active.id;
    const best = new Map<string, UnifiedSong>();
    for (const song of merged) {
        const key = searchResultKey(song);
        const current = best.get(key);
        if (!current || (isFromActive(song) && !isFromActive(current))) best.set(key, song);
    }

    const items = [...best.values()];
    const result: OmniPage<UnifiedSong> = {
        items: items.slice(0, page.limit),
        hasMore: items.length > page.limit,
        nextOffset: page.offset + Math.min(items.length, page.limit),
    };
    lastAggregateSearch = { query, limit: page.limit, at: Date.now(), page: result };
    return result;
};

export const omni = {
    invalidateActiveRequests(): void {
        activeRequestGeneration += 1;
    },

    getActiveRequestGeneration(): number {
        return activeRequestGeneration;
    },

    // The provider list changes at runtime (Folium mods). A useSyncExternalStore pair for the UI.
    subscribeProviders(listener: () => void): () => void {
        return subscribeOnlineMusicProviderRegistry(listener);
    },

    getProviderRegistryVersion(): number {
        return getOnlineMusicProviderRegistryVersion();
    },

    getProviderSummaries(): OmniProviderSummary[] {
        const accounts = useOnlineProviderAccountStore.getState().accounts;
        return listOnlineMusicProviders().map(provider => {
            const account = accounts[provider.id];
            // 游客（guest/guestAccess.ts）：账号层有一个确定的 userId，歌单与喜欢清单照常答空。
            // `user` 必须原样带上——首页的推荐 / 公开歌单以「provider + userId」为归属，抹成 null 会让
            // 游客的首页一条都不读（这正是未登录首页全空的原因）。界面靠 `guest` 标志与 `status:'anonymous'`
            // 显示「未登录」，两条信息各管一件事。
            const guest = isGuestUser(account?.user);
            return {
                providerId: provider.id,
                displayName: provider.displayName,
                shortName: provider.shortName || provider.displayName,
                availability: provider.getAvailability?.() ?? { configured: true },
                requiresAccount: provider.capabilities.auth,
                status: guest ? 'anonymous' : (account?.status || 'unknown'),
                user: account?.user || null,
                ...(guest ? { guest: true as const } : {}),
                collections: account?.collections || [],
                error: account?.error,
                hydration: account?.hydration || 'loading',
                freshness: account?.freshness || 'stale',
                lastUpdatedAt: account?.lastUpdatedAt,
            };
        });
    },

    getActiveProviderSummary(): OmniProviderSummary | undefined {
        const providerId = activeProviderId();
        return this.getProviderSummaries().find(provider => provider.providerId === providerId);
    },

    // Reads cached like state through Omni. A heart pressed and not yet settled answers with what
    // was asked for (`pressSongLike`).
    isSongLiked(song: SongResult): boolean {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return false;

        const account = useOnlineProviderAccountStore.getState().accounts[source.providerId];
        const songKey = String(source.mediaId);
        const wanted = account?.wantedLikes?.[songKey];
        if (wanted !== undefined) return wanted;

        for (const id of account?.likedSongIds || []) {
            if (String(id) === songKey) return true;
        }
        return false;
    },

    // Toggles a song through its source provider. `likeSong` is what keeps the account cache in
    // sync, so every entry point - this one, the liked grid, a command - lands in the same state.
    async toggleSongLike(song: SongResult): Promise<boolean> {
        const nextLiked = !this.isSongLiked(song);
        await this.likeSong(song, nextLiked);
        return nextLiked;
    },

    getActiveCapabilities(): OmniProviderCapabilities {
        return activeProvider().capabilities;
    },

    getProviderCapabilities(providerId: OmniProviderId): OmniProviderCapabilities {
        return requireOnlineMusicProvider(providerId).capabilities;
    },

    supportsDailySongs(providerId: OmniProviderId): boolean {
        return typeof requireOnlineMusicProvider(providerId).recommendations?.getDailySongs === 'function';
    },

    getProviderLabel(providerId: OmniProviderId): string {
        const provider = getOnlineMusicProvider(providerId);
        return provider?.shortName || provider?.displayName || providerId;
    },

    async searchSongs(query: string, page: PageInput): Promise<OmniPage<UnifiedSong>> {
        const trimmed = query.trim();
        if (!trimmed) return emptyPage(page.offset);
        // 第一页聚合（活跃源 + 最多三个其它源）；翻页仍走活跃源——每个源的游标不同，
        // 混在一起翻会重复或跳条。
        if (page.offset > 0) {
            return withActiveProvider(async provider => {
                if (!providerSupports(provider, 'search') || !provider.search) return emptyPage(page.offset);
                return provider.search.searchSongs(trimmed, page.limit, page.offset);
            });
        }
        return aggregateSearch(trimmed, page);
    },

    async searchProviderSongs(providerId: OmniProviderId, query: string, page: PageInput): Promise<OmniPage<UnifiedSong>> {
        const provider = requireOnlineMusicProvider(providerId);
        if (!providerSupports(provider, 'search') || !provider.search) return emptyPage(page.offset);
        return provider.search.searchSongs(query, page.limit, page.offset);
    },

    // 平台的记号（一个字和一种颜色）。平台没有声明就回 null，界面自己从它的短名取。
    getProviderMark(providerId: OmniProviderId): ProviderMark | null {
        return getOnlineMusicProvider(providerId)?.mark ?? null;
    },

    // 登录窗口里这个平台自己的标题和说明（i18n key）；没有声明就回 null。
    getLoginTexts(providerId: OmniProviderId): LoginTexts | null {
        return getOnlineMusicProvider(providerId)?.auth?.getLoginTexts?.() ?? null;
    },

    // Starts what each provider watches while the app is open (`watch`): the registered ones,
    // once. Answers with the way to stop them all.
    watchProviders(tell: (notice: ProviderNotice) => void): () => void {
        const stops = listOnlineMusicProviders().flatMap(provider => (provider.watch ? [provider.watch(tell)] : []));
        return () => stops.forEach(stop => stop());
    },

    // 登录要靠的、可以在登录窗口里重启的本地服务；这个平台没有就回 null。
    getLoginLocalService(providerId: OmniProviderId): LoginLocalService | null {
        return getOnlineMusicProvider(providerId)?.auth?.localService ?? null;
    },

    // 没有这个能力就回空数组，UI 据此走单步流程；netease / kugou 完全不受影响。
    getLoginMethods(providerId: OmniProviderId): LoginMethod[] {
        return requireOnlineMusicProvider(providerId).auth?.getLoginMethods?.() ?? [];
    },

    async resolveLoginMethods(providerId: OmniProviderId): Promise<LoginMethod[]> {
        const auth = requireOnlineMusicProvider(providerId).auth;
        if (!auth) return [];
        return auth.resolveLoginMethods?.() ?? auth.getLoginMethods?.() ?? [];
    },

    // 扫码的 provider 回二维码图片；在浏览器里确认的登录没有图片，回空串。
    async startLogin(providerId: OmniProviderId, methodId?: string): Promise<{ key: string; imageUrl: string }> {
        const provider = requireOnlineMusicProvider(providerId);
        const auth = provider.auth;
        if (!auth?.startLogin || (!auth.createQr && !auth.openLoginPage)) return unsupported(providerId, 'qr-login');
        return runLoginStep(auth, 'start', async () => {
            const key = await auth.startLogin!(methodId);
            return { key, imageUrl: auth.createQr ? await auth.createQr(key) : '' };
        });
    },

    // 在浏览器里确认的登录：没有二维码，UI 留一个打开浏览器的按钮。
    confirmsLoginInBrowser(providerId: OmniProviderId): boolean {
        const auth = requireOnlineMusicProvider(providerId).auth;
        return Boolean(auth?.openLoginPage && !auth.createQr);
    },

    // 这一次登录的页面由 provider 自己打开、不能再打开一次（`opensLoginPageItself`）。
    opensLoginPageItself(providerId: OmniProviderId, key: string): boolean {
        return requireOnlineMusicProvider(providerId).auth?.opensLoginPageItself?.(key) === true;
    },

    async openLoginPage(providerId: OmniProviderId, key: string): Promise<void> {
        const auth = requireOnlineMusicProvider(providerId).auth;
        if (!auth?.openLoginPage) return unsupported(providerId, 'qr-login-page');
        await runLoginStep(auth, 'open', () => auth.openLoginPage!(key));
    },

    async checkLogin(providerId: OmniProviderId, key: string): Promise<LoginState> {
        const auth = requireOnlineMusicProvider(providerId).auth;
        if (!auth?.checkLogin) return unsupported(providerId, 'qr-login');
        return runLoginStep(auth, 'check', () => auth.checkLogin!(key));
    },

    // 没有这个能力就静默 no-op：netease / kugou 的扫码流程完全不受影响。
    async cancelLogin(providerId: OmniProviderId, key: string): Promise<void> {
        await requireOnlineMusicProvider(providerId).auth?.cancelLogin?.(key);
    },

    // 诊断是失败之后的补救手段，自己不能再失败：provider 没实现就回空，抛错就把错误写进报告。
    async getLoginDiagnostics(providerId: OmniProviderId): Promise<LoginDiagnosticLine[]> {
        try {
            return await requireOnlineMusicProvider(providerId).auth?.getLoginDiagnostics?.() ?? [];
        } catch (error) {
            return [diagnosticLine`provider diagnostics unavailable: ${errorMessage(error)}`];
        }
    },

    // 登录失败后的主动自检：没有这个能力的 provider（mod 源也是）回 false / null。
    // 自检本身出错时照常抛出，由登录记进时间线与报告。
    canRunLoginSelfCheck(providerId: OmniProviderId): boolean {
        return Boolean(requireOnlineMusicProvider(providerId).auth?.canRunLoginSelfCheck?.());
    },

    async runLoginSelfCheck(providerId: OmniProviderId): Promise<LoginSelfCheckResult | null> {
        return await requireOnlineMusicProvider(providerId).auth?.runLoginSelfCheck?.() ?? null;
    },

    // 只有明确声明了这一次登录有效期的 provider 才由前端计时；其余照旧只认后端报出的过期状态。
    getLoginTtlMs(providerId: OmniProviderId): number | null {
        const ttlMs = requireOnlineMusicProvider(providerId).auth?.getLoginTtlMs?.();
        return typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : null;
    },

    async getUserPlaylists(userId: MediaId, page: PageInput): Promise<OmniPage<OmniCollection>> {
        return withActiveProvider(async provider => provider.library?.getUserPlaylists?.(userId, page.limit, page.offset) ?? emptyPage(page.offset));
    },

    // Reads who is signed in to a provider, their playlists and their liked songs from the
    // platform, and settles them in the account store (account/accountRead.ts): at app start,
    // after a sign-in, at a platform switch and for the sync button. A read asked for while one
    // of the provider is under way joins it. Never rejects.
    readAccount(providerId: OmniProviderId, reason: AccountReadReason): Promise<AccountReadOutcome> {
        return accountReads.read(providerId, reason);
    },

    // The listener signs out of a provider: the account leaves the screen at once, the platform
    // is told, and what was kept of the account on disk goes. Never rejects.
    signOutAccount(providerId: OmniProviderId): Promise<void> {
        return accountReads.signOut(providerId);
    },

    // Reads the playlists of the account shown again, after a change made to one in Folia and
    // when the home screen is entered, and keeps them with the account. Rejects where they could
    // not be read.
    refreshProviderPlaylists(providerId: OmniProviderId): Promise<OmniCollection[]> {
        return accountReads.readPlaylists(providerId);
    },

    // Returns the cached playlists owned by the provider that owns the current song.
    getPlaylistsForSong(song: SongResult): OmniCollection[] {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return [];
        const provider = getOnlineMusicProvider(source.providerId);
        if (
            !providerSupports(provider, 'mutations')
            || !providerSupports(provider, 'playlistTrackMutations')
            || !provider?.mutations?.updatePlaylistTracks
        ) {
            return [];
        }
        const collections = useOnlineProviderAccountStore.getState().accounts[source.providerId]?.collections || [];
        return collections.filter(collection => (
            collection.type === 'playlist'
            && (provider.mutations?.canAddToPlaylist?.(collection) ?? true)
        ));
    },

    canAddSongToPlaylist(song: SongResult): boolean {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return false;
        const provider = getOnlineMusicProvider(source.providerId);
        return providerSupports(provider, 'mutations')
            && providerSupports(provider, 'playlistTrackMutations')
            && Boolean(provider?.mutations?.updatePlaylistTracks);
    },

    // Whether a playlist can be made on the song's provider to put the song in.
    canCreatePlaylistForSong(song: SongResult): boolean {
        const source = getPlaybackSourceRef(song);
        return source.kind === 'online'
            && this.canAddSongToPlaylist(song)
            && Boolean(getOnlineMusicProvider(source.providerId)?.mutations?.createPlaylist);
    },

    canLikeSong(song: SongResult): boolean {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return false;
        const provider = getOnlineMusicProvider(source.providerId);
        return providerSupports(provider, 'mutations')
            && providerSupports(provider, 'likes')
            && Boolean(provider?.mutations?.likeSong);
    },

    canEditCollectionTracks(collection: OmniCollection): boolean {
        const provider = getOnlineMusicProvider(collection.providerId);
        if (!providerSupports(provider, 'mutations')) return false;
        if (collection.isLiked === true) {
            return providerSupports(provider, 'likes') && Boolean(provider?.mutations?.likeSong);
        }
        return providerSupports(provider, 'playlistTrackMutations')
            && Boolean(provider?.mutations?.updatePlaylistTracks)
            && (provider?.mutations?.canEditPlaylistTracks?.(collection) ?? true);
    },

    canDislikeSong(song: SongResult): boolean {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return false;
        const provider = getOnlineMusicProvider(source.providerId);
        return providerSupports(provider, 'recommendations')
            && Boolean(provider?.recommendations?.dislikeSong);
    },

    /** 每日推荐里「不喜欢并换一首」：集合所属 provider 有 dislikeSong 才能管理推荐（有日推不等于能不喜欢）。 */
    canDislikeCollectionSongs(collection: OmniCollection): boolean {
        const provider = getOnlineMusicProvider(collection.providerId);
        return providerSupports(provider, 'recommendations')
            && Boolean(provider?.recommendations?.dislikeSong);
    },

    canSubscribeCollection(collection: OmniCollection): boolean {
        const provider = getOnlineMusicProvider(collection.providerId);
        if (
            !providerSupports(provider, 'mutations')
            || !providerSupports(provider, 'playlistSubscription')
            || provider?.mutations?.canSubscribe?.(collection) === false
        ) {
            return false;
        }
        if (collection.type === 'album') return Boolean(provider?.mutations?.subscribeAlbum);
        // 自己的歌单（含「我喜欢」）谈不上收藏。以前靠「能编辑就不显示收藏」挡住，但有的平台能收藏歌单却不能红心，
        // 「我喜欢」编辑不了，会落到收藏分支，一点就是去收藏自己的 201 目录。
        if (collection.isOwned === true || collection.isLiked === true) return false;
        return Boolean(provider?.mutations?.subscribePlaylist);
    },

    async getUserAlbums(userId: MediaId, page: PageInput): Promise<OmniPage<OmniCollection>> {
        return withActiveProvider(async provider => provider.library?.getUserAlbums?.(userId, page.limit, page.offset) ?? emptyPage(page.offset));
    },

    // A provider without this read answers with nothing read, and not whole: nothing held is taken away.
    async getLikedSongIds(userId: MediaId): Promise<ProviderLikedSongIds> {
        return withActiveProvider(async provider => provider.library?.getLikedSongIds?.(userId) ?? { ids: [], whole: false });
    },

    async getProviderLikedSongIds(providerId: OmniProviderId, userId: MediaId): Promise<ProviderLikedSongIds> {
        return requireOnlineMusicProvider(providerId).library?.getLikedSongIds?.(userId) ?? { ids: [], whole: false };
    },

    async getCloudCollection(user?: OmniUser): Promise<OmniCollection | null> {
        return withActiveProvider(async provider => provider.library?.getCloudCollection?.(user) ?? null);
    },

    async getHomeFeed(limit = 35): Promise<{
        personalFm: UnifiedSong[];
        dailySongs: UnifiedSong[];
        recommendedCollections: OmniCollection[];
        /** 有一块失败、按空处理了：调用方可以照常显示，但下次应该再读一遍。 */
        partial?: true;
    }> {
        return withActiveProvider(async provider => {
            const recommendations = provider.recommendations;
            // 游客没有「私人」FM：那一路对匿名会话只会回一首和谁都一样的歌，失败还会把整份 feed 标成
            // partial（于是每次进电台都重读）。只问公开的两块：每日推荐（匿名也有 3 首）与推荐歌单。
            const guest = isGuestUser(useOnlineProviderAccountStore.getState().accounts[provider.id]?.user);
            // 三块各自成败：一块失败（例如日推被上游拒绝）只让那一块为空、结果标成 partial，不把 FM 与推荐歌单
            // 一起拖下去；三块都失败才算这次首页推荐失败。作废（AbortError）不算某一块的失败，整次照常作废。
            const [personalFm, dailySongs, recommendedCollections] = await Promise.allSettled([
                guest ? [] : (recommendations?.getPersonalFm?.() ?? []),
                recommendations?.getDailySongs?.() ?? [],
                recommendations?.getRecommendedCollections?.(limit) ?? [],
            ]);
            const settled = [personalFm, dailySongs, recommendedCollections];
            const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            const aborted = failures.find(failure => (failure.reason as { name?: unknown } | null)?.name === 'AbortError');
            if (aborted) throw aborted.reason;
            if (failures.length === settled.length) throw failures[0].reason;
            failures.forEach(failure => console.warn('[Omni] Home feed section failed', {
                providerId: provider.id,
                ...errorFields(failure.reason),
            }));
            const valueOf = <T>(result: PromiseSettledResult<T[]>): T[] => (result.status === 'fulfilled' ? result.value : []);
            return {
                personalFm: valueOf(personalFm),
                dailySongs: valueOf(dailySongs),
                recommendedCollections: valueOf(recommendedCollections),
                ...(failures.length > 0 ? { partial: true as const } : {}),
            };
        });
    },

    async getPersonalFm(options?: PersonalFmRequestOptions): Promise<UnifiedSong[]> {
        return withActiveProvider(async provider => provider.recommendations?.getPersonalFm?.(options) ?? []);
    },

    async getDailySongs(refresh?: boolean): Promise<UnifiedSong[]> {
        return withActiveProvider(async provider => provider.recommendations?.getDailySongs?.(refresh) ?? []);
    },

    async getRecommendationHistory(): Promise<OmniHistoryEntry[]> {
        return withActiveProvider(async provider => provider.recommendations?.getHistoryEntries?.() ?? []);
    },

    async getRecommendationHistoryDates(): Promise<string[]> {
        return withActiveProvider(async provider => provider.recommendations?.getHistoryDates?.() ?? []);
    },

    async getRecommendationHistorySongs(entry: OmniHistoryEntry | string): Promise<UnifiedSong[]> {
        return withActiveProvider(async provider => provider.recommendations?.getHistorySongs?.(entry) ?? []);
    },

    supportsExplore(providerId: OmniProviderId): boolean {
        const provider = getOnlineMusicProvider(providerId);
        return providerSupports(provider, 'explore') && Boolean(provider?.explore);
    },

    // The active provider's own recommendation page; `cursor` asks for its further sections, and
    // `listened` (see `OnlineExploreProvider`) goes with a read from the start.
    async getExploreFeed(cursor?: string, listened?: UnifiedSong[]): Promise<OmniExplorePage> {
        return withActiveProvider(async provider => provider.explore?.getFeed(cursor, listened) ?? { sections: [] });
    },

    async getExploreSectionItems(cursor: string): Promise<OmniExploreItemsPage> {
        return withActiveProvider(async provider => provider.explore?.getSectionItems?.(cursor) ?? { items: [] });
    },

    async getSongDetail(providerId: OmniProviderId, id: MediaId): Promise<UnifiedSong | null> {
        return requireOnlineMusicProvider(providerId).playback?.getSongDetail(id) ?? null;
    },

    canPlaySong(song: SongResult): boolean {
        return Boolean(getOnlineMusicProviderForSong(song)?.playback);
    },

    // The quality levels a provider tells apart, lowest first (`OnlinePlaybackProvider.audioQualityLevels`;
    // standard, high, lossless and hires without it): the ones the quality option shows for it.
    // Read anew on every call: a provider's list may change with its account.
    getAudioQualityLevels(providerId: OmniProviderId): readonly AudioQualityPreference[] {
        return audioQualityLevelsOf(providerId);
    },

    // The level `preference` means to a provider: the one the quality option lights, and the one
    // `getAudioSource` asks the provider for.
    resolveAudioQuality(providerId: OmniProviderId, preference: AudioQualityPreference): AudioQualityPreference {
        return audioQualityFor(providerId, preference);
    },

    async getAudioSource(song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> {
        const provider = providerForSong(song);
        const level = audioQualityFor(provider.id, quality);
        // 兜底源只在**内置源给不出完整版**时接手：没有地址，或者只给了试听片段。
        // 顺序是这里最容易搞错的一处：以前是「先按 fee/权限判定，再直接问兜底源」，那样一首本来
        // 能完整播放的歌，只要被打上 fee=1 就再也没机会被内置源回答，直接换成兜底源的试听。
        // 现在先问内置源，拿到 preview 或失败之后才兜底。
        //
        // 放在这里而不是 restorePlaybackSource.ts：缓存键、级别记录、ReplayGain、扩展钩子都在这个
        // 函数后面，预取和会话恢复也走同一条路。
        //
        // 档位要先按「兜底源分得清的档」收敛一次再问它：一个只到 high 的源被问了 lossless，只会
        // 给回一个 high 的文件，然后再被当成 lossless 记进缓存。`lockedSongFallbackProviderId()`
        // 永不返回空（没配就是 `custom`）；这个 id 没注册时 `audioQualityFor` 按「没有声明档位」
        // 处理（standard/high/lossless/hires），而且这个值只在桥接真拿到地址时才会被用到，
        // 那种情况下 provider 一定注册着——所以不存在「拿不到 id 就不 clamp」的退化路径。
        const fallbackProviderId = lockedSongFallbackProviderId();
        const fallbackLevel = audioQualityFor(fallbackProviderId, level);
        // 一个地址到手之后的收尾只写一处：ReplayGain、URL 的级别与试听标记、扩展钩子。内置源与兜底源
        // 都从这里出去，免得两份收尾各活各的。
        //
        // Written here rather than at either caller because this is the only moment a provider ever
        // states a track's ReplayGain, and both callers - the prefetch pass and playback itself -
        // may be the one that happens to see it. See getCachedSongReplayGain for what is lost
        // otherwise: the URL is never fetched again once the bytes are cached.
        //
        // The level asked for, not `source.quality`: a provider may serve a lower one, and a reader
        // of the media cache asks with the level the preference resolves to. Noted before the hook
        // below, so a URL an extension swaps in stays of an unknown level, and is not known to be a
        // clip: the mark is the provider's word about its own URL.
        // (A provider that lists the levels it tells apart is the exception: where it names another
        // of them, the file is that level's own, and a copy of it is kept as of that level. Kept as
        // of the level asked for, it would play in that level's place for good.)
        const finish = (
            source: OmniAudioSource | null,
            listed?: readonly AudioQualityPreference[],
        ): Promise<OmniAudioSource | null> => {
            if (source?.replayGain) void saveSongReplayGain(song, source.replayGain);
            if (source?.url) {
                noteAudioSourceLevel(source.url, {
                    level: listed?.includes(source.quality) ? source.quality : level,
                    preview: Boolean(source.preview),
                });
            }
            // Extension layers (Folium omni hooks) may swap the URL; the ReplayGain above stays the provider's.
            return applyOmniAudioHook(song, source);
        };
        let source: OmniAudioSource | null = null;
        let failure: unknown = null;
        try {
            source = await runRequest(provider, 'audio', async () => await (provider.playback?.getAudioSource(song, level) ?? null));
        } catch (error) {
            failure = error;
        }

        // 平台没标 preview，给的却可能是片段（有的平台直接回一条 30 秒的 URL，`freeTrialInfo`
        // 却是空的）。**每首都量一次**：一次 HEAD 几十毫秒，比「猜哪些歌可能受限」可靠——
        // 从推荐/歌单进来的歌经常不带 fee，按权限标记筛会把它们整批漏掉。
        let servedAsClip = false;
        if (source?.url && !source.preview && song.durationMs > 60_000) {
            servedAsClip = await isClipAudio(source.url, song.durationMs);
            if (servedAsClip) {
                console.info('[ClipProbe] 这条地址比这首歌短得多，改问兜底源', {
                    song: song.name,
                    expectedMs: song.durationMs,
                });
            }
        }

        // 内置源没有完整版（无地址、标了试听、或实测是片段）时，才给兜底源一次机会。
        if (!source?.url || source.preview || servedAsClip) {
            console.info(`[Fallback] 内置源没有完整版，开始问兜底源：${song.name}（preview=${Boolean(source?.preview)} noUrl=${!source?.url} clipped=${servedAsClip}）`);
            let bridged: OmniAudioSource | null = null;
            try {
                bridged = await resolveLockedSongAudio(song, fallbackLevel, { force: true });
            } catch (error) {
                console.warn('[Omni] Fallback routing failed; the built-in source answer stands', error);
            }
            if (bridged) {
                // 片段校验在路由里已经做过（每个候选都会实测一次），这里直接采用。
                // 兜底源自己的档位交给 finish：它声明了另一档，副本就按那一档记（否则按被问的那一档）。
                return finish(bridged, getOnlineMusicProvider(fallbackProviderId)?.playback?.audioQualityLevels);
            }
        }

        if (failure) {
            // The provider gave no address. An extension may still give one, as it may where the provider answers null;
            // without one the very error goes on, for the caller to sort (failure/onlineFailureCase.ts).
            const fromHook = await applyOmniAudioHook(song, null);
            if (fromHook?.url) return fromHook;
            throw failure;
        }
        // 兜底也没拿到完整版：把这条片段标成 preview，让界面说「试听」，而不是把 30 秒当整首。
        if (servedAsClip && source) {
            return finish({ ...source, preview: true }, provider.playback?.audioQualityLevels);
        }
        return finish(source, provider.playback?.audioQualityLevels);
    },

    // The level a URL handed out by `getAudioSource` was asked for at. Undefined for any other URL
    // (a local file, a Navidrome stream, a blob), and for one handed out too long ago to be remembered.
    levelOfAudioSource(url: string): AudioQualityPreference | undefined {
        return audioSourceLevels.get(audioSourceLevelKey(url))?.level;
    },

    // Whether a URL handed out by `getAudioSource` plays a preview clip of its song, as its provider
    // said. False for any other URL, as for one handed out too long ago to be remembered.
    isPreviewAudioSource(url: string): boolean {
        return audioSourceLevels.get(audioSourceLevelKey(url))?.preview === true;
    },

    // Asked once per track, including for local and Navidrome songs, so an unsupported source is a
    // plain `false` rather than the throw `providerForSong` would raise. A song its provider
    // cannot vouch for (`canReport`) is false too.
    canReportPlayback(song: SongResult): boolean {
        const provider = getOnlineMusicProviderForSong(song);
        if (!providerSupports(provider, 'playbackReports') || !provider?.playbackReports) return false;
        return provider.playbackReports.canReport?.(song) ?? true;
    },

    async reportPlayback(song: SongResult, report: OmniPlaybackReport): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.playbackReports) return unsupported(provider.id, 'playbackReports');
        await provider.playbackReports.reportPlayback(song, report);
    },

    async getLyrics(song: SongResult, context?: { userId?: MediaId | null }): Promise<OmniLyricsResult> {
        const provider = providerForSong(song);
        if (!provider.lyrics) return unsupported(provider.id, 'lyrics');
        const providerUserId = useOnlineProviderAccountStore.getState().accounts[provider.id]?.user?.id ?? context?.userId;
        const providerResult = await provider.lyrics.getLyrics(song, { ...context, userId: providerUserId });
        const resolved = (await resolveProviderLyricsChorus(providerResult, {
            providerId: provider.id,
            songId: song.id,
        })).result;
        // Extension layers (Folium omni hooks) may rewrite the lyrics after the provider answered.
        return applyOmniLyricsHook(song, resolved);
    },

    async getChorusRanges(song: SongResult): Promise<OmniChorusRange[]> {
        const provider = providerForSong(song);
        return provider.lyrics?.getChorusRanges?.(song.id) ?? [];
    },

    // Another name the song's artist may be listed under elsewhere, when its provider knows one.
    async getAlternateArtistName(song: SongResult): Promise<string | null> {
        return await getOnlineMusicProviderForSong(song)?.lyrics?.getAlternateArtistName?.(song) ?? null;
    },

    getSongAvailability(song: SongResult): OmniSongAvailability {
        return providerForSong(song).playback?.getAvailability?.(song) ?? { state: 'unknown' };
    },

    // A lookup that fails is described as a failed request for the song's audio is: the caller tells a
    // network that failed from a version that is not there.
    async getSongReplacement(song: SongResult): Promise<OmniSongReplacement | null> {
        const provider = providerForSong(song);
        return runRequest(provider, 'audio', async () => await (provider.playback?.getReplacement?.(song) ?? null));
    },

    async getCollectionTracks(collection: OmniCollection, page: PageInput): Promise<OmniPage<UnifiedSong>> {
        const provider = providerForCollection(collection);
        return runRequest(provider, 'collection', async () => {
            if (collection.type === 'album') {
                return await (provider.catalog?.getAlbumTracks?.(collection.id, page.limit, page.offset, collection) ?? emptyPage(page.offset));
            }
            if (collection.type === 'cloud') {
                return await (provider.catalog?.getCloudTracks?.(page.limit, page.offset, collection) ?? emptyPage(page.offset));
            }
            return await (provider.catalog?.getPlaylistTracks?.(collection.id, page.limit, page.offset, collection) ?? emptyPage(page.offset));
        });
    },

    async getAlbumDetail(collection: OmniCollection): Promise<OmniCollection | null> {
        return providerForCollection(collection).catalog?.getAlbumDetail?.(collection.id, collection) ?? null;
    },

    async getCollectionDetail(collection: OmniCollection): Promise<OmniCollection | null> {
        const catalog = providerForCollection(collection).catalog;
        if (collection.type === 'album') return catalog?.getAlbumDetail?.(collection.id, collection) ?? collection;
        if (collection.type === 'playlist') return catalog?.getPlaylistDetail?.(collection.id, collection) ?? collection;
        return collection;
    },

    async getArtistDetail(collection: OmniCollection): Promise<OmniCollection | null> {
        return providerForCollection(collection).catalog?.getArtistDetail?.(collection.id) ?? null;
    },

    async getArtistSongs(collection: OmniCollection, page: PageInput): Promise<OmniPage<UnifiedSong>> {
        return providerForCollection(collection).catalog?.getArtistSongs?.(collection.id, page.limit, page.offset) ?? emptyPage(page.offset);
    },

    async getArtistAlbums(collection: OmniCollection, page: PageInput): Promise<OmniPage<OmniCollection>> {
        return providerForCollection(collection).catalog?.getArtistAlbums?.(collection.id, page.limit, page.offset) ?? emptyPage(page.offset);
    },

    async getSubscriptionStatus(collection: OmniCollection): Promise<boolean> {
        const type = collection.type === 'album' ? 'album' : 'playlist';
        return providerForCollection(collection).catalog?.getSubscriptionStatus?.(type, collection.id, collection) ?? false;
    },

    async subscribe(collection: OmniCollection, subscribed: boolean): Promise<void> {
        const mutations = providerForCollection(collection).mutations;
        if (!this.canSubscribeCollection(collection)) {
            return unsupported(collection.providerId, 'collection-subscription');
        }
        if (collection.type === 'album') {
            if (!mutations?.subscribeAlbum) return unsupported(collection.providerId, 'album-subscription');
            return mutations.subscribeAlbum(collection.id, subscribed);
        }
        if (!mutations?.subscribePlaylist) return unsupported(collection.providerId, 'playlist-subscription');
        return mutations.subscribePlaylist(collection, subscribed);
    },

    async updateCollectionTracks(collection: OmniCollection, operation: 'add' | 'del', tracks: SongResult[]): Promise<void> {
        const provider = providerForCollection(collection);
        const mutations = provider.mutations;
        if (
            !providerSupports(provider, 'mutations')
            || !providerSupports(provider, 'playlistTrackMutations')
            || !mutations?.updatePlaylistTracks
        ) {
            return unsupported(collection.providerId, 'playlist-track-mutations');
        }
        return mutations.updatePlaylistTracks(operation, collection, tracks);
    },

    // Makes a playlist on the song's provider and puts the song in it.
    async createPlaylistWithSong(song: SongResult, name: string): Promise<void> {
        const source = getPlaybackSourceRef(song);
        const mutations = source.kind === 'online' ? getOnlineMusicProvider(source.providerId)?.mutations : undefined;
        if (source.kind !== 'online' || !this.canCreatePlaylistForSong(song) || !mutations?.createPlaylist) {
            throw new OnlineProviderError('unsupported', 'Song provider does not make playlists', source.kind === 'online' ? source.providerId : undefined);
        }
        const playlist = await mutations.createPlaylist(name);
        try {
            await this.addSongToPlaylist(song, playlist);
        } catch (error) {
            // The playlist exists: it must show in the picker, or a second try makes a second one.
            void this.refreshProviderPlaylists(playlist.providerId).catch(() => undefined);
            throw error;
        }
    },

    async addSongToPlaylist(song: SongResult, playlist: OmniCollection): Promise<void> {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') {
            throw new OnlineProviderError('unsupported', 'Only online songs can be added to online playlists');
        }
        if (playlist.providerId !== source.providerId || playlist.type !== 'playlist') {
            throw new OnlineProviderError('unsupported', 'Playlist does not belong to the song provider', source.providerId);
        }
        if (!this.canAddSongToPlaylist(song)) {
            throw new OnlineProviderError('unsupported', 'Song provider does not support playlist track mutations', source.providerId);
        }
        const provider = providerForCollection(playlist);
        if (provider.mutations?.canAddToPlaylist && !provider.mutations.canAddToPlaylist(playlist)) {
            throw new OnlineProviderError('unsupported', 'Playlist does not accept track mutations', source.providerId);
        }
        await this.updateCollectionTracks(playlist, 'add', [song]);
        try {
            await this.refreshProviderPlaylists(playlist.providerId);
            if (playlist.isLiked === true && providerSupports(provider, 'likes')) {
                const userId = useOnlineProviderAccountStore.getState().accounts[playlist.providerId]?.user?.id;
                if (userId !== undefined && userId !== null) {
                    // A full liked list may be large: success does not wait for it.
                    void readLikedSongIds(playlist.providerId, userId).catch(error => {
                        console.warn('[Omni] Failed to refresh liked songs after playlist mutation', { providerId: playlist.providerId }, error);
                    });
                }
            }
        } catch (error) {
            console.warn('[Omni] Failed to refresh provider playlists after mutation', { providerId: playlist.providerId }, error);
        }
    },

    // A press on a song's heart: the other state than the one shown, or `liked` where it is given.
    // The heart answers at once - until the request is settled, `isSongLiked` says what was asked
    // for - and the request goes out after, one at a time for a song (likePresses.ts). `settled`
    // tells how it ended and never rejects; after a failed request the heart shows what the
    // account holds again. Throws at once where the song's provider takes no likes.
    pressSongLike(song: SongResult, liked?: boolean): LikePress {
        const provider = providerForSong(song);
        if (!this.canLikeSong(song) || !provider.mutations?.likeSong) return unsupported(provider.id, 'likes');

        // canLikeSong 已经保证了这一点，这里只是把类型收窄；真走到就说明上面的判断被绕过了。
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return unsupported(provider.id, 'likes');

        const press = likePressesOf(source.providerId).press(
            String(source.mediaId),
            liked ?? !this.isSongLiked(song),
            (sent, signal) => sendSongLike(provider, song, source, sent, signal),
        );
        if (!press.joined) {
            void press.settled.then(outcome => {
                if (outcome.ok) return;
                console.warn(`[Like] ${source.providerId}:${String(source.mediaId)} put back: it shows ${this.isSongLiked(song) ? 'liked' : 'not liked'} again, which is what the account holds`);
            });
        }
        return press;
    },

    // The same press, waited for: resolves once the provider holds `liked`. Rejects when a
    // request failed, and when a heart pressed again meanwhile left the provider with the other
    // state: the caller did not get what it asked for (the liked list's grid keeps the row then).
    async likeSong(song: SongResult, liked: boolean): Promise<void> {
        const outcome = await this.pressSongLike(song, liked).settled;
        if (!outcome.ok) throw outcome.error;
        if (outcome.liked !== liked) {
            throw new Error(`The song ended ${outcome.liked ? 'liked' : 'not liked'}: its heart was pressed again meanwhile`);
        }
    },

    // The start of a read of a collection's songs from its first page. For the signed-in account's
    // liked list it answers with a note of the moment, to be handed back with the songs when the
    // read is over (`endLikedListRead`); for any other collection, with null.
    beginLikedListRead(collection: OmniCollection): LikedListRead | null {
        if (collection.isLiked !== true) return null;
        const account = useOnlineProviderAccountStore.getState().accounts[collection.providerId];
        const userId = account?.user?.id;
        if (userId === undefined || userId === null || !providerSupports(getOnlineMusicProvider(collection.providerId), 'likes')) return null;
        // The account's own liked list stands in its library with the mark. A list that only
        // carries the mark (someone else's, say) is not taken for it.
        const isOwn = (account?.collections || []).some(own => (
            own.isLiked === true && own.type === collection.type && String(own.id) === String(collection.id)
        ));
        return isOwn ? beginLikedRead(collection.providerId, userId) : null;
    },

    // The end of a read of the liked list. `whole`: every page was read in one go, none failed,
    // and the provider said the list ends there. The songs read meet what the account holds by the
    // one rule (account/keptAfterRead.ts): read whole, a song that left the list elsewhere loses
    // its heart here; not read whole, the list only adds hearts, and the songs in play are checked
    // (account/likedChecks.ts). While a pressed song's request is unsettled, what was asked for is
    // shown anyway.
    endLikedListRead(read: LikedListRead, songs: SongResult[], whole: boolean): void {
        const ids: MediaId[] = [];
        for (const song of songs) {
            const source = getPlaybackSourceRef(song);
            if (source.kind === 'online' && source.providerId === read.providerId) ids.push(source.mediaId);
        }
        if (applyLikedIdsRead(read, { ids, whole }).changed) void persistProviderLikedSongIds(read.providerId);
    },

    // A moment at which the account shown may have been changed in the platform's own app
    // (src/hooks/useAccountReads.ts tells of them). At the home screen its playlists are read
    // again (accountRead.ts guards how often); whether the platform is asked for its liked songs
    // is decided in account/readMoments.ts. Answers how the read of the playlists ended, 'not
    // asked' where none was made. Never throws or rejects.
    accountMoment(moment: AccountMoment): Promise<AccountReadOutcome> {
        const providerId = activeProviderId();
        const playlists = moment === 'home-entered' ? accountReads.readAtHome(providerId) : Promise.resolve<AccountReadOutcome>('not asked');
        void accountMoments(moment, providerId);
        return playlists;
    },

    // The songs being played and queued, the one playing first (src/hooks/useAccountReads.ts
    // tells of them). Where a platform's liked list was not read to the end, their hearts are
    // asked of the platform (account/likedChecks.ts). Never throws or rejects.
    songsInPlay(songs: SongResult[]): void {
        const inPlay: SongInPlay[] = [];
        for (const song of songs) {
            const source = getPlaybackSourceRef(song);
            if (source.kind === 'online') inPlay.push({ providerId: source.providerId, mediaId: source.mediaId });
        }
        likedChecks.songsInPlay(inPlay);
    },

    async dislikeSong(song: SongResult): Promise<{ replacement?: UnifiedSong; limitReached?: boolean }> {
        const provider = providerForSong(song);
        if (!this.canDislikeSong(song) || !provider.recommendations?.dislikeSong) {
            return unsupported(provider.id, 'recommendation-dislike');
        }
        return provider.recommendations.dislikeSong(song.id);
    },

    canResolveCatalogRef(song: UnifiedSong, _kind: ProviderCatalogEntityKind): boolean {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return false;
        const catalog = getOnlineMusicProvider(source.providerId)?.catalog;
        return Boolean(catalog?.resolveSongCatalogRefs || catalog?.canResolveSongCatalogRefs?.(song));
    },

    async resolveCatalogRefs(song: UnifiedSong): Promise<UnifiedSong> {
        const source = getPlaybackSourceRef(song);
        if (source.kind !== 'online') return song;
        return getOnlineMusicProvider(source.providerId)?.catalog?.resolveSongCatalogRefs?.(song) ?? song;
    },

    getSongPageUrl(song: SongResult): string | null {
        return providerForSong(song).getSongPageUrl?.(song) ?? null;
    },
};

export type OmniService = typeof omni;
