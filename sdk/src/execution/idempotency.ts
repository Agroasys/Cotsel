/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ExecutionCapability, ExecutionObservation } from './adapters';
import type { CustodyMode } from './custody';
import type { ExpectedExecutionObservation } from './verification';

/** Stored result. Durable stores must serialize bigint amounts losslessly. */
export interface StoredExecutionResult {
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  operationRef: string | null;
  reason?: string;
  observation?: ExecutionObservation;
}

export interface ExecutionIdempotencyRecord {
  /** `<capability>:<idempotencyKey>`. */
  key: string;
  capability: ExecutionCapability;
  /** Canonical hash of the request; a reused key with another request is a conflict. */
  fingerprint: string;
  adapterId: string;
  settlementId: string | null;
  custodyMode: CustodyMode;
  configHash: string;
  expected: ExpectedExecutionObservation;
  /** `in_flight` until the submit returns; the claim is never dropped after that. */
  state: 'in_flight' | 'recorded';
  result: StoredExecutionResult | null;
}

/**
 * Durable claims for submits. `claim` must be atomic insert-if-absent across every
 * process that shares the store; the durable implementation belongs with the
 * broadcast-identity work in #644. `release` is called only when the router can
 * prove nothing reached the provider.
 */
export interface ExecutionIdempotencyStore {
  claim(record: ExecutionIdempotencyRecord): Promise<ExecutionIdempotencyRecord | null>;
  get(key: string): Promise<ExecutionIdempotencyRecord | null>;
  record(key: string, result: StoredExecutionResult): Promise<void>;
  release(key: string): Promise<void>;
}

/**
 * Process-local store for tests and single-process tools. It does not survive a
 * restart, so it must not back a deployment that moves value.
 */
export function createInMemoryExecutionIdempotencyStore(): ExecutionIdempotencyStore {
  const records = new Map<string, ExecutionIdempotencyRecord>();
  const copy = (record: ExecutionIdempotencyRecord): ExecutionIdempotencyRecord =>
    structuredClone(record);
  return {
    async claim(record) {
      const existing = records.get(record.key);
      if (existing) {
        return copy(existing);
      }
      records.set(record.key, copy(record));
      return null;
    },
    async get(key) {
      const record = records.get(key);
      return record ? copy(record) : null;
    },
    async record(key, result) {
      const record = records.get(key);
      if (!record) {
        throw new Error(`No idempotency claim for ${key}`);
      }
      records.set(key, { ...record, state: 'recorded', result: structuredClone(result) });
    },
    async release(key) {
      records.delete(key);
    },
  };
}
