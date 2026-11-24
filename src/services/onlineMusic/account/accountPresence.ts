// src/services/onlineMusic/account/accountPresence.ts
// Read-only account-presence queries for leaf utilities. An account is signed in when its state
// holds a user; this lives in services so utils/lyrics need not import a store (D102).

import { useOnlineProviderAccountStore, type OnlineProviderAccountState } from '../../../stores/useOnlineProviderAccountStore';
import type { OnlineProviderId } from '../../../types/onlineMusic';

/** Whether a provider currently holds a user in its account state. */
export const hasOnlineProviderUser = (providerId: OnlineProviderId): boolean => {
    // Accounts are created lazily per provider: a cold start can read a session before its row exists.
    const accounts: Record<string, OnlineProviderAccountState | undefined> = useOnlineProviderAccountStore.getState().accounts;
    return Boolean(accounts[providerId]?.user);
};
