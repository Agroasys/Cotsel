/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Short-lived in-memory store for login challenges.
 *
 * When a user wants to log in, we issue them a one-time nonce to sign with
 * their wallet. This store holds that nonce for a short TTL (default 5 min).
 * On server restart challenges are invalidated — users simply request a new one.
 */

export interface ChallengeStore {
  /** Store a nonce for the given wallet address. Overwrites any existing entry. */
  set(wallet: string, nonce: string, ttlSeconds: number): void;
  /** Retrieve the nonce for a wallet, or null if missing/expired. */
  get(wallet: string): string | null;
  /** Remove the nonce (called immediately after successful verification). */
  delete(wallet: string): void;
}

export function createInMemoryChallengeStore(): ChallengeStore {
  const store = new Map<string, { nonce: string; expiresAt: number }>();

  // Purge expired entries every minute so the Map does not grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of store.entries()) {
      if (val.expiresAt <= now) store.delete(key);
    }
  }, 60_000);

  // Do not keep the process alive just for cleanup.
  timer.unref();

  return {
    set(wallet, nonce, ttlSeconds) {
      store.set(wallet.toLowerCase(), {
        nonce,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },

    get(wallet) {
      const entry = store.get(wallet.toLowerCase());
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(wallet.toLowerCase());
        return null;
      }
      return entry.nonce;
    },

    delete(wallet) {
      store.delete(wallet.toLowerCase());
    },
  };
}
