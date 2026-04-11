import { createPostgresNonceStore } from '@agroasys/shared-auth';

interface StoreState {
  nowMs: number;
  entries: Map<string, number>;
}

function createQuery(state: StoreState) {
  return async (
    _sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ accepted: boolean }> }> => {
    const [apiKey, nonce, ttlSeconds] = params as [string, string, number];

    for (const [key, expiresAt] of state.entries.entries()) {
      if (expiresAt <= state.nowMs) {
        state.entries.delete(key);
      }
    }

    const key = `${apiKey}:${nonce}`;
    const expiresAt = state.entries.get(key);
    if (expiresAt && expiresAt > state.nowMs) {
      return { rows: [{ accepted: false }] };
    }

    state.entries.set(key, state.nowMs + ttlSeconds * 1000);
    return { rows: [{ accepted: true }] };
  };
}

describe('treasury postgres nonce store', () => {
  test('replay is rejected across store instances', async () => {
    const state: StoreState = { nowMs: 1_700_000_000_000, entries: new Map() };
    const query = createQuery(state);

    const firstInstance = createPostgresNonceStore({
      tableName: 'treasury_auth_nonces',
      query,
    });

    const secondInstance = createPostgresNonceStore({
      tableName: 'treasury_auth_nonces',
      query,
    });

    await expect(firstInstance.consume('svc-a', 'nonce-1', 600)).resolves.toBe(true);
    await expect(secondInstance.consume('svc-a', 'nonce-1', 600)).resolves.toBe(false);
  });
});
