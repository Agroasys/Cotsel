import { createInMemoryNonceStore } from '@agroasys/shared-auth';

describe('in-memory nonce store', () => {
  test('accepts first nonce and rejects replay within ttl', async () => {
    const store = createInMemoryNonceStore({ nowMs: () => 1_700_000_000_000 });

    await expect(store.consume('svc-a', 'nonce-1', 600)).resolves.toBe(true);
    await expect(store.consume('svc-a', 'nonce-1', 600)).resolves.toBe(false);
  });

  test('allows reuse after ttl expiry', async () => {
    let nowMs = 1_700_000_000_000;
    const store = createInMemoryNonceStore({ nowMs: () => nowMs });

    await expect(store.consume('svc-a', 'nonce-1', 1)).resolves.toBe(true);

    nowMs += 1_500;

    await expect(store.consume('svc-a', 'nonce-1', 1)).resolves.toBe(true);
  });

  test('isolates nonce namespace by api key', async () => {
    const store = createInMemoryNonceStore({ nowMs: () => 1_700_000_000_000 });

    await expect(store.consume('svc-a', 'nonce-1', 600)).resolves.toBe(true);
    await expect(store.consume('svc-b', 'nonce-1', 600)).resolves.toBe(true);
  });
});
