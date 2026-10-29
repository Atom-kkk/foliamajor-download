// src/services/onlineMusic/audioProbe.ts
//
// 判断一条地址给的是「整首」还是「片段」。
//
// 为什么不能只看 provider 的 `preview`：那个标记来自平台的响应字段（如 `freeTrialInfo`），
// 有些歌平台直接给一条 30 秒的 URL，字段却是空的——于是播放器把它当成整首，进度条显示 00:30，
// 下载下来也是 30 秒。这里改用音频自己的元数据说话。
//
// **一个元素，一次一条。** 探测曾经是每次 `new Audio()`，播放、预取、下载三条路各建一个；几个
// media 元素同时抓着解码器和连接，拖动进度条时会明显卡顿。现在复用同一个元素，探测排队执行，
// 并缓存结果（同一 URL 一分钟内只测一次）——播放、预取、下载问的是同一个地址，没必要测三遍。
//
// 用 `<audio preload="metadata">` 而不是下载整段：浏览器只取头部，几百毫秒就有 duration，
// 且 `<audio>` 不受 CORS 限制。拿不到（超时、格式不支持、地址一次性失效）时返回 null，调用方
// 按「不确定」处理，不要因此误判成片段。

/** 比整首短这么多才算片段：绝对差 20 秒、且不到 70%。两个条件都满足，避免短歌被误伤。 */
const CLIP_ABSOLUTE_GAP_MS = 20_000;
const CLIP_RATIO = 0.7;

/** 一次探测最多等这么久。取不到就当「不确定」，不要让它拖住播放。 */
const PROBE_TIMEOUT_MS = 4_000;
/** 结果缓存：同一地址一分钟内不再重复探测。 */
const CACHE_TTL_MS = 60_000;

let probeElement: HTMLAudioElement | null = null;
/** 串行队列：同一时刻只有一个探测在跑，避免多个 media 元素抢解码器。 */
let queue: Promise<unknown> = Promise.resolve();
/** 正在排队/执行的探测数。预取一次会问好几首，堆太多会把播放的那一次挤到后面。 */
let pending = 0;
const MAX_PENDING = 2;
const cache = new Map<string, { ms: number | null; at: number }>();

const element = (): HTMLAudioElement | null => {
    if (typeof Audio === 'undefined') return null;
    if (!probeElement) {
        probeElement = new Audio();
        probeElement.preload = 'metadata';
        probeElement.muted = true;
    }
    return probeElement;
};

const measure = (url: string, timeoutMs: number): Promise<number | null> => new Promise<number | null>(resolve => {
    const audio = element();
    if (!audio) {
        resolve(null);
        return;
    }

    let settled = false;
    let timer: number | null = null;

    const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        if (timer !== null) window.clearTimeout(timer);
        // 让这个元素停下来并放开连接；元素本身留着复用。
        try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        } catch { /* 元素已经不需要了 */ }
    };

    const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
    };

    const onLoaded = () => {
        const seconds = audio.duration;
        finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    };
    const onError = () => finish(null);

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    timer = window.setTimeout(() => finish(null), timeoutMs);
    audio.src = url;
});

export const probeAudioDurationMs = async (url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> => {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ms;
    // 预取会把队列占满；这时候宁可「不确定」，也不要让播放的取址排在它后面。
    if (pending >= MAX_PENDING) return null;

    pending += 1;
    const run = queue.then(() => measure(url, timeoutMs));
    // 队列里只关心「上一条跑完了」，不关心它成没成。
    queue = run.catch(() => undefined).finally(() => { pending -= 1; });
    const value = await run;
    cache.set(url, { ms: value, at: Date.now() });
    return value;
};

/**
 * 实测时长是否明显短于这首歌应有的时长。`expectedMs` 未知（0）时一律认为不是片段——
 * 宁可放过，也不要凭一个空值把好地址丢掉。
 */
export const looksLikeClip = (actualMs: number | null, expectedMs: number): boolean => {
    if (!actualMs || !expectedMs || expectedMs <= 0) return false;
    return actualMs < expectedMs * CLIP_RATIO && expectedMs - actualMs > CLIP_ABSOLUTE_GAP_MS;
};

/**
 * 拿不到时长时的第二道判据：**字节数**。
 *
 * 一首 4 分 51 秒的歌，即使按 48 kbps 算也要约 1.7 MB；只有 800 KB 就说明它不可能是整首。
 * 48 kbps 是正规音乐的下限，用它当分母不会误伤低码率的完整文件。
 */
export const looksLikeClipBySize = (bytes: number | null, expectedMs: number): boolean => {
    if (!bytes || !expectedMs || expectedMs <= 0) return false;
    const minimumBytes = (expectedMs / 1000) * 6_000;
    return bytes < minimumBytes;
};

/** 主进程量出来的字节数（electron/audioSizeProbe.cjs）；桌面端之外为 null。 */
export const probeAudioSize = async (url: string): Promise<number | null> => {
    const api = typeof window === 'undefined' ? undefined : window.electron?.probeAudioSize;
    if (!api) return null;
    try {
        return await api(url);
    } catch {
        return null;
    }
};

/**
 * 是不是一段被截断的音频。
 *
 * **先量字节**：一次 HEAD 就够（几十毫秒），不依赖解码器，也不会因为一次性签名地址而失败。
 * 字节量不到时才退回 `<audio>` 的时长探测（那个最多要等 4 秒）。
 */
export const isClipAudio = async (url: string, expectedMs: number): Promise<boolean> => {
    const bytes = await probeAudioSize(url);
    if (bytes !== null) return looksLikeClipBySize(bytes, expectedMs);
    const actualMs = await probeAudioDurationMs(url);
    return actualMs !== null ? looksLikeClip(actualMs, expectedMs) : false;
};
