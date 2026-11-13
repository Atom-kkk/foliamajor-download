import type { OnlineProviderId } from '../../../types/onlineMusic';

// src/services/onlineMusic/custom/customSourceConfig.ts
//
// 自定义音源（第三方源）的地址与开关。
//
// 地址有两个来源，按优先级：
//   1. localStorage 里的 `folia.customSource.v1`（`{ baseUrl, token, enabled }`），方便改完即用、
//      和仓库里的构建产物无关；
//   2. 构建期环境变量 VITE_CUSTOM_SOURCE_BASE / VITE_CUSTOM_SOURCE_TOKEN。
//
// 没有地址时这个源是 `configured: false`：它不出现成错误，只是没人用它。

export const CUSTOM_SOURCE_ID: OnlineProviderId = 'custom';

export const CUSTOM_SOURCE_STORAGE_KEY = 'folia.customSource.v1';

export interface CustomSourceConfig {
    /** 形如 `http://127.0.0.1:8787`，末尾斜杠会被去掉。空串表示没配。 */
    baseUrl: string;
    /** 可选，随每个请求发 `Authorization: Bearer <token>`。 */
    token: string;
    /** 关掉就整个源停用（连同锁歌路由的兜底一起停）。 */
    enabled: boolean;
}

const viteEnv = (key: string): string => {
    try {
        const env = typeof import.meta !== 'undefined'
            ? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
            : undefined;
        return String(env?.[key] ?? '').trim();
    } catch {
        return '';
    }
};

const trimBase = (value: string): string => value.trim().replace(/\/+$/, '');

const readStored = (): Partial<CustomSourceConfig> | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(CUSTOM_SOURCE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CustomSourceConfig> | null;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn('[CustomSource] 本地配置读不出来，忽略', error);
        return null;
    }
};

export const readCustomSourceConfig = (): CustomSourceConfig => {
    const stored = readStored();
    const baseUrl = trimBase(
        typeof stored?.baseUrl === 'string' && stored.baseUrl.trim()
            ? stored.baseUrl
            : viteEnv('VITE_CUSTOM_SOURCE_BASE'),
    );
    const token = typeof stored?.token === 'string' && stored.token.trim()
        ? stored.token.trim()
        : viteEnv('VITE_CUSTOM_SOURCE_TOKEN');
    // 只要存了 enabled: false 就听它的：这是「我暂时不用这个源」的唯一开关。
    const enabled = stored?.enabled !== false && Boolean(baseUrl);
    return { baseUrl, token, enabled };
};

/** 这个源现在可用吗：有地址、且没被关掉。 */
export const isCustomSourceConfigured = (): boolean => readCustomSourceConfig().enabled;

/** 写配置（调试用；也可以直接改 localStorage）。 */
export const writeCustomSourceConfig = (patch: Partial<CustomSourceConfig>): CustomSourceConfig => {
    const next: CustomSourceConfig = { ...readCustomSourceConfig(), ...patch };
    const normalized: CustomSourceConfig = {
        baseUrl: trimBase(next.baseUrl),
        token: String(next.token ?? '').trim(),
        enabled: next.enabled !== false && Boolean(trimBase(next.baseUrl)),
    };
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(CUSTOM_SOURCE_STORAGE_KEY, JSON.stringify(normalized));
        } catch (error) {
            console.warn('[CustomSource] 配置写不进去', error);
        }
    }
    return normalized;
};

/**
 * 锁歌（VIP / 会员限定）转发到哪个 provider。默认就是这个自定义源。
 * `VITE_LOCKED_SONG_FALLBACK_PROVIDER` 可以指到别的已注册 provider（例如另一个 mod 源）。
 */
export const lockedSongFallbackProviderId = (): OnlineProviderId => (
    viteEnv('VITE_LOCKED_SONG_FALLBACK_PROVIDER') || CUSTOM_SOURCE_ID
);

/**
 * 整体开关：关掉就完全不碰 omni 的取址路径，等同于上游行为。
 * 默认开——真正决定「这一首转不转」的是 `lockedSongRouting.ts` 里的权限判定。
 */
export const isLockedSongRoutingEnabled = (): boolean => viteEnv('VITE_LOCKED_SONG_ROUTING') !== 'off';
