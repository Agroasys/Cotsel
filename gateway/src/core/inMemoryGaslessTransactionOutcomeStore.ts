/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  GaslessConfirmedOutcome,
  GaslessTransactionIdentity,
  GaslessTransactionOutcomeRecord,
  GaslessTransactionOutcomeStatus,
  GaslessTransactionOutcomeStore,
} from './gaslessTransactionOutcomeStore';

interface InMemoryOutcome extends GaslessTransactionOutcomeRecord {
  lastReconciliationAttemptAt: string | null;
  confirmation?: GaslessConfirmedOutcome;
}

export function createInMemoryGaslessTransactionOutcomeStore(): GaslessTransactionOutcomeStore {
  const records = new Map<string, InMemoryOutcome>();

  function requireRecord(transactionHash: string): InMemoryOutcome {
    const record = records.get(transactionHash.toLowerCase());
    if (!record) throw new Error(`Unknown gasless transaction outcome ${transactionHash}`);
    return record;
  }

  function update(
    transactionHash: string,
    outcomeStatus: GaslessTransactionOutcomeStatus,
    details: {
      failureCode?: string | null;
      observedTransactionHash?: string;
      confirmation?: GaslessConfirmedOutcome;
    } = {},
  ): void {
    const current = requireRecord(transactionHash);
    records.set(transactionHash.toLowerCase(), {
      ...current,
      outcomeStatus,
      failureCode: details.failureCode ?? current.failureCode,
      observedTransactionHash: details.observedTransactionHash ?? current.observedTransactionHash,
      confirmation: details.confirmation ?? current.confirmation,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    async recordPrepared(identity: GaslessTransactionIdentity) {
      const key = identity.transactionHash.toLowerCase();
      const existing = records.get(key);
      if (existing) {
        if (
          existing.applicationRequestId !== identity.applicationRequestId ||
          existing.intentHash !== identity.intentHash
        ) {
          throw new Error('Gasless transaction identity conflicts with persisted outcome');
        }
        return;
      }
      const requestConflict = [...records.values()].find(
        (record) => record.applicationRequestId === identity.applicationRequestId,
      );
      if (requestConflict) {
        throw new Error('Gasless application request already has a transaction outcome');
      }
      const now = new Date().toISOString();
      records.set(key, {
        ...structuredClone(identity),
        outcomeStatus: 'broadcast_pending',
        observedTransactionHash: null,
        projectedOutcomeStatus: null,
        failureCode: null,
        updatedAt: now,
        lastReconciliationAttemptAt: null,
      });
    },
    async markBroadcastUnknown(transactionHash, failureCode, observedTransactionHash) {
      update(transactionHash, 'broadcast_unknown', { failureCode, observedTransactionHash });
    },
    async markConfirmationPending(transactionHash) {
      update(transactionHash, 'confirmation_pending');
    },
    async markConfirmed(transactionHash, confirmation) {
      update(transactionHash, 'confirmed', { confirmation });
    },
    async markReverted(transactionHash, confirmation) {
      update(transactionHash, 'reverted', { confirmation });
    },
    async getByApplicationRequestId(applicationRequestId) {
      const record = [...records.values()].find(
        (candidate) => candidate.applicationRequestId === applicationRequestId,
      );
      return record ? structuredClone(record) : null;
    },
    async listRecoveryCandidates(limit) {
      return [...records.values()]
        .filter(
          (record) =>
            ['broadcast_pending', 'broadcast_unknown', 'confirmation_pending'].includes(
              record.outcomeStatus,
            ) || record.projectedOutcomeStatus !== record.outcomeStatus,
        )
        .slice(0, limit)
        .map((record) => structuredClone(record));
    },
    async markRecoveryAttempted(transactionHash) {
      const current = requireRecord(transactionHash);
      records.set(transactionHash.toLowerCase(), {
        ...current,
        lastReconciliationAttemptAt: new Date().toISOString(),
      });
    },
    async markProjectionApplied(transactionHash, status) {
      const current = requireRecord(transactionHash);
      if (current.outcomeStatus !== status) {
        throw new Error('Gasless outcome changed before projection');
      }
      records.set(transactionHash.toLowerCase(), {
        ...current,
        projectedOutcomeStatus: status,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
