import type {
    MediaId,
    OnlineAuthProvider,
    OnlineLibraryProvider,
    OnlineMusicProvider,
    OnlineProviderId,
    ProviderCollection,
    ProviderLikedSongIds,
    ProviderPage,
    ProviderUser,
} from '../../../types/onlineMusic';

// src/services/onlineMusic/guest/guestAccess.ts
//
// 游客身份（guest access）：让内置平台在没有登录的情况下也能用。
//
// 平台适配器（OnlineAuthProvider.getLoginStatus）在没人登录时回 null，账号层（account/accountRead.ts）
// 把 null 读成「没人登录」——**账号整个离开屏幕**，于是 getUserPlaylists / 喜欢清单这一路从此没有
// 可用的 userId，界面上也没有「当前账号」。搜索和播放本来就不需要登录，可一旦有人顺手读了账号，
// 上层就会拿到空账号甚至因为 userId 缺失而抛错。
//
// 这里不改任何平台的适配器，而是在 registry 注册时统一包一层（`withGuestAccess`）：
//
//   - getLoginStatus 永不回 null、永不抛错：真登录就回真账号，否则回一个**稳定的**游客
//     （同一个 id、同一个昵称，`GUEST_USER_ID`），于是账号层拿到一个确定的 userId，读歌单得到空列表，
//     心形得到空集合，界面显示「游客」而不是「未登录 / 错误」。
//   - 游客的 library 读写直接答空，不去打扰平台：getUserPlaylists 之类的上游端点对一个不存在的
//     uid 只会报错，而那个错误会被记成账号失败，最后变成界面上的红字。
//   - logout 仍然交给平台（有就调），不阻止退出；退出后下一次读账号又是游客，状态是稳定的。
//   - 扫码登录、诊断、自检等成员原样保留：想登录的人照旧能登录，登录成功后 getLoginStatus 回真账号，
//     游客身份自然让位。
//
// 包装只在这里写一次，内置平台在 providerRegistry 里统一套上；任何 provider 里都不再出现
// 「硬编码一个假账号」的分叉。要关掉整层：`setGuestAccessEnabled(false)`（或在单测里改 MODE），
// 改动集中、可回滚。

/** 游客账号的 id。它不进任何平台的命名空间，平台侧的 id 是数字或 mid，不会撞上。 */
export const GUEST_USER_ID = 'guest';
/** 游客显示的昵称，「游客」两个字由 UI 直接显示，不走 i18n 表。 */
export const GUEST_USER_NAME = '游客';

// 整层的开关。默认开；离线单测（MODE=test）里关掉，因为账号层自己的用例验的正是「没人登录时账号
// 离开屏幕」这条上游语义，那是这一层之下的合同，不该被产品决策改掉。要单独验这一层，
// 用 `setGuestAccessEnabled(true)`。
const readMode = (): string => {
    try {
        return String((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.MODE ?? '');
    } catch {
        return '';
    }
};

let guestAccessEnabled = readMode() !== 'test';

/** 打开/关掉游客身份（测试与调试用）。关掉之后已经包好的 provider 不会变回原样，注册表要重新注册。 */
export const setGuestAccessEnabled = (enabled: boolean): void => {
    guestAccessEnabled = enabled;
};

export const isGuestAccessEnabled = (): boolean => guestAccessEnabled;

// 包过的 provider 记在这里：同一个 provider 重复注册（mod 热重载、registry 重复 register）
// 时不再套第二层——否则 getLoginStatus 会被包两层、logout 也被调两次。
const wrappedOnce = new WeakMap<OnlineMusicProvider, OnlineMusicProvider>();

/** 一次注册里的同一个游客对象：id 与昵称在所有 provider 之间一致，但对象各自稳定（上层会比对引用）。 */
const guestUsers = new Map<OnlineProviderId, ProviderUser>();

/** 这个平台的游客。同一个平台永远拿到同一个对象。 */
export const guestUserOf = (providerId: OnlineProviderId): ProviderUser => {
    let user = guestUsers.get(providerId);
    if (!user) {
        user = { id: GUEST_USER_ID, nickname: GUEST_USER_NAME };
        guestUsers.set(providerId, user);
    }
    return user;
};

/** 一个 userId 是不是游客。账号层读歌单、读喜欢清单之前用它分流。 */
export const isGuestUserId = (userId: MediaId | null | undefined): boolean => (
    userId !== null && userId !== undefined && String(userId) === GUEST_USER_ID
);

export const isGuestUser = (user: ProviderUser | null | undefined): boolean => isGuestUserId(user?.id);

const emptyPage = <T>(offset: number): ProviderPage<T> => ({ items: [], hasMore: false, nextOffset: offset });

const warned = new Set<string>();
const warnGuestFallback = (providerId: OnlineProviderId, error: unknown): void => {
    // 只记一次：账号读在启动、回窗口、点同步时都会问到，同一个平台刷屏没有意义。
    if (warned.has(providerId)) return;
    warned.add(providerId);
    console.info(
        `[Guest] ${providerId}: 登录状态读不到，按游客继续（之后同一个平台不再提示）`,
        error instanceof Error ? error.message : error,
    );
};

// 认证：真账号优先，其余一律游客；任何一步抛错都不许穿到账号层去。
const wrapAuth = (auth: OnlineAuthProvider, providerId: OnlineProviderId): OnlineAuthProvider => ({
    ...auth,
    async getLoginStatus(): Promise<ProviderUser> {
        try {
            const user = await auth.getLoginStatus();
            return user ?? guestUserOf(providerId);
        } catch (error) {
            warnGuestFallback(providerId, error);
            return guestUserOf(providerId);
        }
    },
    async logout(): Promise<void> {
        try {
            await auth.logout();
        } catch (error) {
            // 退出失败不该让账号留在屏幕上转圈：本地状态照旧由账号层清掉。
            console.warn(`[Guest] ${providerId}: logout 失败，本地照常退出`, error);
        }
    },
    ...(auth.signInRanOut
        ? {
            signInRanOut(): void | Promise<void> {
                try {
                    return auth.signInRanOut!();
                } catch (error) {
                    console.warn(`[Guest] ${providerId}: signInRanOut 失败，忽略`, error);
                    return undefined;
                }
            },
        }
        : {}),
});

// 游客的 library：读写都答空，不往上打请求。平台的账号端点对一个不是账号的 uid 只会报错，
// 那个错误会被账号层记成「账号失败」，最后在界面上变成一条红字——比空列表还糟。
const guestLibraryAnswer = (): OnlineLibraryProvider => ({
    async getUserPlaylists(_userId: MediaId, _limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
        return emptyPage<ProviderCollection>(offset);
    },
});

const wrapLibrary = (library: OnlineLibraryProvider): OnlineLibraryProvider => ({
    ...library,
    async getUserPlaylists(userId: MediaId, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
        if (isGuestUserId(userId)) return emptyPage<ProviderCollection>(offset);
        return library.getUserPlaylists(userId, limit, offset);
    },
    ...(library.getLikedSongIds
        ? {
            async getLikedSongIds(userId: MediaId): Promise<ProviderLikedSongIds> {
                // 游客没有喜欢清单；`whole: false` 让账号层知道这不是「一首都没喜欢」的结论。
                if (isGuestUserId(userId)) return { ids: [], whole: false };
                return library.getLikedSongIds!(userId);
            },
        }
        : {}),
    ...(library.getLikedSongCount
        ? {
            async getLikedSongCount(userId: MediaId): Promise<number | null> {
                if (isGuestUserId(userId)) return 0;
                return library.getLikedSongCount!(userId);
            },
        }
        : {}),
    ...(library.areSongsLiked
        ? {
            async areSongsLiked(ids: MediaId[]): Promise<Record<string, boolean>> {
                return {};
            },
        }
        : {}),
    ...(library.getUserAlbums
        ? {
            async getUserAlbums(userId: MediaId, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
                if (isGuestUserId(userId)) return emptyPage<ProviderCollection>(offset);
                return library.getUserAlbums!(userId, limit, offset);
            },
        }
        : {}),
    ...(library.getCloudCollection
        ? {
            async getCloudCollection(user?: ProviderUser): Promise<ProviderCollection | null> {
                if (!user || isGuestUser(user)) return null;
                return library.getCloudCollection!(user);
            },
        }
        : {}),
});

/**
 * 包一层游客身份。幂等：同一个 provider 包两次还是它自己。
 *
 * 只包有 `auth` 的平台：没有账号概念的源（自定义音源、mod 源）本来就以 `requiresAccount: false`
 * 出现在界面上，账号层对它们是 `nobody`，不需要也不应该塞一个假账号。
 */
export const withGuestAccess = (provider: OnlineMusicProvider): OnlineMusicProvider => {
    if (!guestAccessEnabled) return provider;
    const wrappedBefore = wrappedOnce.get(provider);
    if (wrappedBefore) return wrappedBefore;
    if (!provider.auth) return provider;

    const wrapped: OnlineMusicProvider = {
        ...provider,
        auth: wrapAuth(provider.auth, provider.id),
        library: provider.library ? wrapLibrary(provider.library) : guestLibraryAnswer(),
    };
    wrappedOnce.set(provider, wrapped);
    return wrapped;
};
