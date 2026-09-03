/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IdempotencyRecord, IdempotencyScope, IdempotencyStore } from './idempotencyStore';

function toScopedKey(scope: IdempotencyScope): string {
  return `${scope.actorId}\u0000${scope.endpoint}\u0000${scope.idempotencyKey}`;
}

export function createInMemoryIdempotencyStore(leaseDurationMs = 300_000): IdempotencyStore {
  const store = new Map<string, IdempotencyRecord>();

  return {
    leaseDurationMs,
    async get(scope) {
      return store.get(toScopedKey(scope)) ?? null;
    },

    async getFinancialOutcome() {
      return null;
    },

    async getGaslessCommand() {
      return null;
    },

    async createPending(entry) {
      const scopedKey = toScopedKey(entry);
      const existing = store.get(scopedKey);
      if (existing) {
        if (
          !existing.completedAt &&
          existing.leaseExpiresAt &&
          Date.parse(existing.leaseExpiresAt) <= Date.now() &&
          existing.requestMethod === entry.requestMethod &&
          existing.requestPath === entry.requestPath &&
          existing.requestFingerprint === entry.requestFingerprint
        ) {
          const reclaimed = {
            ...existing,
            requestId: entry.requestId,
            leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
          };
          store.set(scopedKey, reclaimed);
          return { record: reclaimed, created: true };
        }
        return { record: existing, created: false };
      }

      const record: IdempotencyRecord = {
        idempotencyKey: entry.idempotencyKey,
        actorId: entry.actorId,
        endpoint: entry.endpoint,
        requestMethod: entry.requestMethod,
        requestPath: entry.requestPath,
        requestFingerprint: entry.requestFingerprint,
        requestId: entry.requestId,
        responseStatus: null,
        responseHeaders: {},
        responseBody: null,
        completedAt: null,
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
        createdAt: new Date().toISOString(),
      };

      store.set(scopedKey, record);
      return { record, created: true };
    },

    async complete(scope, response, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing) {
        throw new Error(`Missing in-memory idempotency record for ${scope.idempotencyKey}`);
      }
      if (existing.requestId !== leaseOwnerRequestId || existing.completedAt) {
        throw new Error(`Idempotency lease ownership was lost for ${scope.idempotencyKey}`);
      }

      store.set(scopedKey, {
        ...existing,
        responseStatus: response.responseStatus,
        responseHeaders: response.responseHeaders,
        responseBody: response.responseBody,
        completedAt: new Date().toISOString(),
        leaseExpiresAt: null,
      });
    },

    async releasePending(scope, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing || existing.completedAt || existing.requestId !== leaseOwnerRequestId) return;
      store.delete(scopedKey);
    },

    async renewLease(scope, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing || existing.completedAt || existing.requestId !== leaseOwnerRequestId) {
        return false;
      }
      store.set(scopedKey, {
        ...existing,
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
      });
      return true;
    },

    async markReplay(scope) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (existing) store.set(scopedKey, existing);
    },
  };
}
