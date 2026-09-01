/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import {
  GaslessCommandCapacityError,
  GaslessCommandIdentityConflictError,
} from './gaslessCommandStore';
import type {
  CreateGaslessCommandInput,
  GaslessCommandRecord,
  GaslessCommandStore,
} from './gaslessCommandStore';

export interface PreparedInMemoryGaslessCommand {
  record?: GaslessCommandRecord;
  insert: boolean;
}

export interface InMemoryGaslessCommandState {
  prepare(input?: CreateGaslessCommandInput): PreparedInMemoryGaslessCommand;
  commit(prepared: PreparedInMemoryGaslessCommand): void;
  store: GaslessCommandStore;
}

export function createInMemoryGaslessCommandState(): InMemoryGaslessCommandState {
  const commands = new Map<string, GaslessCommandRecord>();
  const requestIndex = new Map<string, string>();
  const intentIndex = new Map<string, string>();

  function clone(record: GaslessCommandRecord): GaslessCommandRecord {
    return structuredClone(record);
  }

  function prepare(input?: CreateGaslessCommandInput): PreparedInMemoryGaslessCommand {
    if (!input) return { insert: false };
    const existingId =
      requestIndex.get(input.applicationRequestId) ?? intentIndex.get(input.intentKey);
    if (existingId) {
      const existing = commands.get(existingId);
      if (
        !existing ||
        existing.intentKey !== input.intentKey ||
        existing.resourceType !== input.resourceType ||
        existing.resourceId !== input.resourceId ||
        existing.operation !== input.operation
      ) {
        throw new GaslessCommandIdentityConflictError(
          input.applicationRequestId,
          'intent_mismatch',
        );
      }
      return { record: clone(existing), insert: false };
    }
    const activeCount = [...commands.values()].filter((record) =>
      ['pending', 'leased', 'outcome_pending'].includes(record.status),
    ).length;
    if (activeCount >= input.maxQueueDepth) {
      throw new GaslessCommandCapacityError(input.maxQueueDepth);
    }
    const now = new Date().toISOString();
    const { maxQueueDepth: _maxQueueDepth, ...storedInput } = input;
    return {
      insert: true,
      record: {
        ...structuredClone(storedInput),
        commandId: randomUUID(),
        status: 'pending',
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        transactionHash: null,
        result: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  function commit(prepared: PreparedInMemoryGaslessCommand): void {
    if (!prepared.insert || !prepared.record) return;
    const record = clone(prepared.record);
    commands.set(record.commandId, record);
    requestIndex.set(record.applicationRequestId, record.commandId);
    intentIndex.set(record.intentKey, record.commandId);
  }

  const store: GaslessCommandStore = {
    async enqueueCommand(input) {
      const prepared = prepare(input);
      commit(prepared);
      return clone(prepared.record!);
    },

    async getCommand(commandId) {
      const record = commands.get(commandId);
      return record ? clone(record) : null;
    },

    async getByApplicationRequestId(applicationRequestId) {
      const commandId = requestIndex.get(applicationRequestId);
      const record = commandId ? commands.get(commandId) : undefined;
      return record ? clone(record) : null;
    },

    async claimDueCommand(leaseOwner, attemptedAt, leaseExpiresAt) {
      for (const record of commands.values()) {
        if (
          record.status === 'leased' &&
          record.leaseExpiresAt !== null &&
          record.leaseExpiresAt <= attemptedAt &&
          record.attemptCount >= record.maxAttempts
        ) {
          commands.set(record.commandId, {
            ...record,
            status: 'dead_letter',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: 'LEASE_ATTEMPTS_EXHAUSTED',
            lastErrorDetail: 'Worker lease expired after the maximum attempt count',
            completedAt: attemptedAt,
            updatedAt: attemptedAt,
          });
        }
      }
      const due = [...commands.values()]
        .filter(
          (record) =>
            record.attemptCount < record.maxAttempts &&
            ((record.status === 'pending' && record.nextAttemptAt <= attemptedAt) ||
              (record.status === 'leased' &&
                record.leaseExpiresAt !== null &&
                record.leaseExpiresAt <= attemptedAt)),
        )
        .sort((left, right) => {
          const dueOrder = left.nextAttemptAt.localeCompare(right.nextAttemptAt);
          return dueOrder || left.createdAt.localeCompare(right.createdAt);
        })[0];
      if (!due) return null;
      const claimed: GaslessCommandRecord = {
        ...due,
        status: 'leased',
        attemptCount: due.attemptCount + 1,
        leaseOwner,
        leaseExpiresAt,
        updatedAt: attemptedAt,
      };
      commands.set(claimed.commandId, claimed);
      return clone(claimed);
    },

    async renewLease(commandId, leaseOwner, leaseExpiresAt) {
      const record = commands.get(commandId);
      if (!record || record.status !== 'leased' || record.leaseOwner !== leaseOwner) return false;
      commands.set(commandId, { ...record, leaseExpiresAt, updatedAt: new Date().toISOString() });
      return true;
    },

    async markCompleted(commandId, leaseOwner, completedAt, result, transactionHash = null) {
      const record = commands.get(commandId);
      if (!record || record.status !== 'leased' || record.leaseOwner !== leaseOwner) return false;
      commands.set(commandId, {
        ...record,
        status: 'completed',
        result: structuredClone(result),
        transactionHash,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        completedAt,
        updatedAt: completedAt,
      });
      return true;
    },

    async markOutcomePending(commandId, leaseOwner, completedAt, transactionHash) {
      const record = commands.get(commandId);
      if (!record || record.status !== 'leased' || record.leaseOwner !== leaseOwner) return false;
      commands.set(commandId, {
        ...record,
        status: 'outcome_pending',
        transactionHash,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: completedAt,
      });
      return true;
    },

    async markFailed(
      commandId,
      leaseOwner,
      completedAt,
      errorCode,
      errorDetail,
      nextAttemptAt,
      deadLetter,
    ) {
      const record = commands.get(commandId);
      if (!record || record.status !== 'leased' || record.leaseOwner !== leaseOwner) return false;
      commands.set(commandId, {
        ...record,
        status: deadLetter ? 'dead_letter' : 'pending',
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorDetail: errorDetail,
        completedAt: deadLetter ? completedAt : null,
        updatedAt: completedAt,
      });
      return true;
    },

    async resolveTransactionOutcome(
      applicationRequestId,
      transactionHash,
      outcomeStatus,
      observedAt,
    ) {
      const commandId = requestIndex.get(applicationRequestId);
      const record = commandId ? commands.get(commandId) : undefined;
      if (!record || !['leased', 'outcome_pending', 'dead_letter'].includes(record.status)) {
        return false;
      }
      if (record.transactionHash && record.transactionHash !== transactionHash) return false;
      const terminal = outcomeStatus === 'confirmed' || outcomeStatus === 'reverted';
      commands.set(record.commandId, {
        ...record,
        status:
          outcomeStatus === 'confirmed'
            ? 'completed'
            : outcomeStatus === 'reverted'
              ? 'failed'
              : 'outcome_pending',
        transactionHash,
        result: terminal
          ? { transactionHash, outcomeStatus, recovered: true, rebroadcastAllowed: false }
          : record.result,
        completedAt: terminal ? observedAt : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        updatedAt: observedAt,
      });
      return true;
    },

    async listDeadLetters(limit) {
      return [...commands.values()]
        .filter((record) => record.status === 'dead_letter')
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(0, limit)
        .map(({ payload: _payload, result: _result, ...record }) => structuredClone(record));
    },

    async redriveDeadLetter(commandId, requestedAt, _auditEntry) {
      const record = commands.get(commandId);
      if (!record || record.status !== 'dead_letter' || record.transactionHash !== null)
        return null;
      const redriven: GaslessCommandRecord = {
        ...record,
        status: 'pending',
        maxAttempts: record.attemptCount + 1,
        nextAttemptAt: requestedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        completedAt: null,
        updatedAt: requestedAt,
      };
      commands.set(commandId, redriven);
      return clone(redriven);
    },

    async getQueueStats(now) {
      const records = [...commands.values()];
      const pending = records.filter((record) => record.status === 'pending');
      return {
        pending: pending.length,
        leased: records.filter((record) => record.status === 'leased').length,
        outcomePending: records.filter((record) => record.status === 'outcome_pending').length,
        deadLetter: records.filter((record) => record.status === 'dead_letter').length,
        expiredLeases: records.filter(
          (record) =>
            record.status === 'leased' &&
            record.leaseExpiresAt !== null &&
            record.leaseExpiresAt <= now,
        ).length,
        oldestPendingAt:
          pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
            ?.createdAt ?? null,
      };
    },
  };

  return { prepare, commit, store };
}

export function createInMemoryGaslessCommandStore(): GaslessCommandStore {
  return createInMemoryGaslessCommandState().store;
}
