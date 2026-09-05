/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import type { IdempotencyFinancialOutcome, IdempotencyStore } from '../src/core/idempotencyStore';
import { startIdempotencyTestServer } from './helpers/idempotencyTestServer';

describe('gateway idempotency middleware', () => {
  test('replays the stored response for duplicate keys', async () => {
    const { server, baseUrl, getExecutionCount } = await startIdempotencyTestServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-1',
        'x-test-actor': 'admin',
      };
      const body = JSON.stringify({ hello: 'world' });

      const first = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get('x-idempotent-replay')).toBe('true');
      expect(firstPayload).toEqual(secondPayload);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('rejects reusing a key for a different payload', async () => {
    const { server, baseUrl } = await startIdempotencyTestServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-2',
        'x-test-actor': 'admin',
      };

      await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ first: true }),
      });

      const response = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ first: false }),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error.code).toBe('CONFLICT');
    } finally {
      server.close();
    }
  });

  test('requires Idempotency-Key on mutation routes', async () => {
    const { server, baseUrl } = await startIdempotencyTestServer();

    try {
      const response = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-actor': 'admin',
        },
        body: JSON.stringify({ missing: true }),
      });
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe('VALIDATION_ERROR');
    } finally {
      server.close();
    }
  });

  test('releases failed reservations after a 5xx response', async () => {
    const { server, baseUrl, getExecutionCount, setFailOnce } = await startIdempotencyTestServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-retry-after-500',
        'x-test-actor': 'admin',
      };
      setFailOnce();

      const first = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ retry: true }),
      });
      expect(first.status).toBe(500);

      const second = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ retry: true }),
      });
      const secondPayload = await second.json();

      expect(second.status).toBe(202);
      expect(secondPayload.success).toBe(true);
      expect(getExecutionCount()).toBe(2);
    } finally {
      server.close();
    }
  });

  test('persists an authoritative reverted outcome and never executes the same key twice', async () => {
    const { server, baseUrl, getExecutionCount, setRevertedOutcomeOnce } =
      await startIdempotencyTestServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-terminal-revert',
        'x-test-actor': 'admin',
      };
      const body = JSON.stringify({ financialOutcome: 'reverted' });
      setRevertedOutcomeOnce();

      const first = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const firstPayload = await first.json();
      const second = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      expect(first.status).toBe(502);
      expect(second.status).toBe(502);
      expect(second.headers.get('x-idempotent-replay')).toBe('true');
      expect(secondPayload).toEqual(firstPayload);
      expect(secondPayload.error.details.outcome).toBe('reverted');
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('persists every idempotent JSON response before it is visible to the caller', async () => {
    const baseStore = createInMemoryIdempotencyStore();
    let releaseCompletion!: () => void;
    let signalCompletionStarted!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completionStarted = new Promise<void>((resolve) => {
      signalCompletionStarted = resolve;
    });
    const store: IdempotencyStore = {
      ...baseStore,
      async complete(scope, response, leaseOwnerRequestId) {
        if (scope.idempotencyKey === 'idem-durable-before-send') {
          signalCompletionStarted();
          await completionGate;
        }
        await baseStore.complete(scope, response, leaseOwnerRequestId);
      },
    };
    const { server, baseUrl } = await startIdempotencyTestServer(store);

    try {
      const responsePromise = fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-durable-before-send',
          'x-test-actor': 'admin',
        },
        body: JSON.stringify({ durable: true }),
      });
      let responseVisible = false;
      void responsePromise.then(() => {
        responseVisible = true;
      });

      await completionStarted;
      await new Promise((resolve) => setImmediate(resolve));
      expect(responseVisible).toBe(false);
      releaseCompletion();

      const response = await responsePromise;
      expect(response.status).toBe(202);
    } finally {
      releaseCompletion();
      server.close();
    }
  });

  test('retains the reservation when a financial broadcast outcome is unresolved', async () => {
    const baseStore = createInMemoryIdempotencyStore();
    let outcomeStatus: IdempotencyFinancialOutcome['outcomeStatus'] = 'broadcast_unknown';
    const store: IdempotencyStore = {
      ...baseStore,
      async getFinancialOutcome(requestId) {
        return {
          requestId,
          transactionHash: `0x${'a'.repeat(64)}`,
          resourceType: 'platform_transfer',
          resourceId: 'transfer-1',
          operation: 'wallet_usdc_transfer',
          chainId: 84532,
          outcomeStatus,
        };
      },
    };
    const { server, baseUrl, getExecutionCount, setUnresolvedOutcomeOnce } =
      await startIdempotencyTestServer(store);

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-unresolved-broadcast',
        'x-test-actor': 'admin',
      };
      const body = JSON.stringify({ financialOutcome: 'unknown' });
      setUnresolvedOutcomeOnce();

      const first = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const second = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      outcomeStatus = 'confirmed';
      const third = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const thirdPayload = await third.json();
      const fourth = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const fourthPayload = await fourth.json();

      expect(first.status).toBe(503);
      expect(second.status).toBe(202);
      expect(second.headers.get('x-financial-outcome-recovery')).toBe('true');
      expect(secondPayload.data).toEqual(
        expect.objectContaining({
          outcomeStatus: 'broadcast_unknown',
          rebroadcastAllowed: false,
        }),
      );
      expect(third.status).toBe(202);
      expect(thirdPayload.data.outcomeStatus).toBe('confirmed');
      expect(fourth.status).toBe(202);
      expect(fourth.headers.get('x-idempotent-replay')).toBe('true');
      expect(fourthPayload).toEqual(thirdPayload);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('replays a recovered on-chain revert as a terminal failure without rebroadcast', async () => {
    const baseStore = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...baseStore,
      async getFinancialOutcome(requestId) {
        return {
          requestId,
          transactionHash: `0x${'c'.repeat(64)}`,
          resourceType: 'platform_transfer',
          resourceId: 'transfer-reverted',
          operation: 'wallet_usdc_transfer',
          chainId: 84532,
          outcomeStatus: 'reverted',
        };
      },
    };
    const { server, baseUrl, getExecutionCount, setUnresolvedOutcomeOnce } =
      await startIdempotencyTestServer(store);

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-recovered-revert',
        'x-test-actor': 'admin',
      };
      const body = JSON.stringify({ financialOutcome: 'unknown-then-reverted' });
      setUnresolvedOutcomeOnce();

      const first = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const second = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const secondPayload = await second.json();
      const third = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const thirdPayload = await third.json();

      expect(first.status).toBe(503);
      expect(second.status).toBe(502);
      expect(second.headers.get('x-financial-outcome-recovery')).toBe('true');
      expect(secondPayload.success).toBe(false);
      expect(secondPayload.error.details).toEqual(
        expect.objectContaining({
          outcome: 'reverted',
          transactionHash: `0x${'c'.repeat(64)}`,
          rebroadcastAllowed: false,
        }),
      );
      expect(third.status).toBe(502);
      expect(third.headers.get('x-idempotent-replay')).toBe('true');
      expect(thirdPayload).toEqual(secondPayload);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('reserves a new idempotency key atomically under concurrent requests', async () => {
    const { server, baseUrl, getExecutionCount, setSlowMutationMs } =
      await startIdempotencyTestServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-concurrent',
        'x-test-actor': 'admin',
      };
      setSlowMutationMs(50);
      const body = JSON.stringify({ parallel: true });

      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body }),
        fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([202, 409]);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('scopes identical idempotency keys by actor identity', async () => {
    const { server, baseUrl, getExecutionCount } = await startIdempotencyTestServer();

    try {
      const body = JSON.stringify({ scoped: true });
      const adminResponse = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-shared',
          'x-test-actor': 'admin',
        },
        body,
      });
      const adminPayload = await adminResponse.json();

      const buyerResponse = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-shared',
          'x-test-actor': 'buyer',
        },
        body,
      });
      const buyerPayload = await buyerResponse.json();

      expect(adminResponse.status).toBe(202);
      expect(buyerResponse.status).toBe(202);
      expect(adminPayload.executionCount).toBe(1);
      expect(buyerPayload.executionCount).toBe(2);
      expect(buyerResponse.headers.get('x-idempotent-replay')).toBeNull();
      expect(getExecutionCount()).toBe(2);
    } finally {
      server.close();
    }
  });
});
