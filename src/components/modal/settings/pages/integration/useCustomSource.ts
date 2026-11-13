import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    CUSTOM_SOURCE_STORAGE_KEY,
    readCustomSourceConfig,
    writeCustomSourceConfig,
    type CustomSourceConfig,
} from '../../../../../services/onlineMusic/custom/customSourceConfig';

// src/components/modal/settings/pages/integration/useCustomSource.ts
// The custom-source form of the 连接与集成 page. The address and token are a draft until saved;
// "test" asks the service for one search result and says what came back (so a CORS problem reads
// as a CORS problem rather than as "the source is broken"); "save" writes the same place the
// provider reads — localStorage — and reloads, because the registry resolves a provider's
// availability when it is registered, not when the address changes.
//
// The three states of the switch are worth knowing: a stored `enabled: false` is the user saying
// "not now" and is kept; with no stored value the switch starts on, so filling the address in is
// all it takes to turn the source on.

type CustomSourceAction = 'idle' | 'testing' | 'saving';

/** Long enough for a cold local service, short enough that a wrong address is not a hang. */
const TEST_TIMEOUT_MS = 8_000;

/** The address as the provider will read it: trimmed, no trailing slashes. */
const normalizeBase = (value: string): string => value.trim().replace(/\/+$/, '');

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a search answer holds, whichever of the shapes the contract accepts it used. */
const itemsOf = (body: unknown): unknown[] | null => {
    if (Array.isArray(body)) return body;
    if (body === null || typeof body !== 'object') return null;
    const record = body as Record<string, unknown>;
    for (const key of ['items', 'songs', 'data', 'result', 'list']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
        if (value !== null && typeof value === 'object') {
            const nested = value as Record<string, unknown>;
            if (Array.isArray(nested.items)) return nested.items;
            if (Array.isArray(nested.songs)) return nested.songs;
        }
    }
    return null;
};

const initialConfig = (): CustomSourceConfig => {
    const stored = readCustomSourceConfig();
    // Never configured: the switch starts on, and it is the address that decides whether the
    // source is actually used. Explicitly turned off before: leave it off.
    return { ...stored, enabled: stored.enabled || !stored.baseUrl };
};

export const useCustomSource = () => {
    const { t } = useTranslation();
    const [saved, setSaved] = useState<CustomSourceConfig>(initialConfig);
    const [draft, setDraft] = useState<CustomSourceConfig>(initialConfig);
    const [action, setAction] = useState<CustomSourceAction>('idle');
    const [summary, setSummary] = useState<string | null>(null);
    const [tone, setTone] = useState<'ok' | 'error' | undefined>(undefined);

    const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
    const configured = Boolean(normalizeBase(draft.baseUrl));

    const update = (patch: Partial<CustomSourceConfig>) => {
        setDraft(previous => ({ ...previous, ...patch }));
        setSummary(null);
        setTone(undefined);
    };

    const test = async () => {
        const base = normalizeBase(draft.baseUrl);
        setSummary(null);
        setTone(undefined);
        if (!base) {
            setTone('error');
            setSummary(t('options.customSourceTestNoAddress'));
            return;
        }
        setAction('testing');
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        const timer = controller ? window.setTimeout(() => controller.abort(), TEST_TIMEOUT_MS) : 0;
        try {
            const response = await fetch(`${base}/search?keyword=${encodeURIComponent('test')}&limit=1`, {
                method: 'GET',
                headers: draft.token.trim() ? { Authorization: `Bearer ${draft.token.trim()}` } : undefined,
                ...(controller ? { signal: controller.signal } : {}),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json() as unknown;
            const items = itemsOf(body);
            if (items === null) {
                setTone('error');
                setSummary(t('options.customSourceTestBadShape'));
                return;
            }
            setTone('ok');
            setSummary(items.length > 0
                ? t('options.customSourceTestOk', { count: items.length })
                : t('options.customSourceTestEmpty'));
        } catch (error) {
            setTone('error');
            const aborted = (error as { name?: unknown } | null)?.name === 'AbortError';
            setSummary(t(aborted ? 'options.customSourceTestTimeout' : 'options.customSourceTestFailed', {
                reason: aborted ? `${TEST_TIMEOUT_MS} ms` : errorText(error),
            }));
        } finally {
            if (timer) window.clearTimeout(timer);
            setAction('idle');
        }
    };

    /**
     * Writes the address where the provider reads it, then reloads: the registry asks a provider
     * whether it is configured once, when it is registered, so nothing short of a reload makes the
     * new address visible to the source list and the locked-song routing.
     */
    const saveAndReload = () => {
        setAction('saving');
        const next = writeCustomSourceConfig(draft);
        setSaved(next);
        setDraft(next);
        setTone('ok');
        setSummary(t('options.customSourceSavedReloading'));
        window.setTimeout(() => window.location.reload(), 600);
    };

    return {
        draft,
        dirty,
        configured,
        action,
        summary,
        tone,
        storageKey: CUSTOM_SOURCE_STORAGE_KEY,
        update,
        test,
        saveAndReload,
    };
};
