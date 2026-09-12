/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AuditLogEntry, AuditLogStore } from './auditLogStore';
import type { GovernanceActionRecord, GovernanceActionStore } from './governanceStore';
import { ensurePreparedSigningPayload } from './governanceSigning';
import { GatewayError } from '../errors';

export interface GovernanceConfirmationCommit {
  actionId: string;
  transactionHash: string;
  signerBindingId: string;
  signerWallet: string;
  preparedPayloadHash: string;
  committedAt: string;
  transition: GovernanceActionRecord;
  auditEntry: AuditLogEntry;
  lateBroadcast?: boolean;
}

export interface GovernanceMonitorClaim {
  action: GovernanceActionRecord;
  workerId: string;
  leaseToken: string;
  transitionVersion: number;
  leaseExpiresAt: string;
}

export interface GovernanceTransitionStore {
  commitConfirmation(input: GovernanceConfirmationCommit): Promise<GovernanceActionRecord>;
  claimMonitorActions(input: {
    workerId: string;
    claimedAt: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<GovernanceMonitorClaim[]>;
  completeMonitorClaim(
    claim: GovernanceMonitorClaim,
    transition: GovernanceActionRecord,
    auditEntry: AuditLogEntry,
    completedAt: string,
  ): Promise<GovernanceActionRecord | null>;
  releaseMonitorClaim(claim: GovernanceMonitorClaim): Promise<boolean>;
}

function conflict(message: string, details: Record<string, unknown>): never {
  throw new GatewayError(409, 'CONFLICT', message, details);
}

export function resolveGovernanceConfirmationCommit(
  current: GovernanceActionRecord | null,
  input: GovernanceConfirmationCommit,
): { action: GovernanceActionRecord; idempotent: boolean } {
  if (!current) {
    throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', {
      actionId: input.actionId,
    });
  }

  const transactionHash = input.transactionHash.toLowerCase();
  const currentHash = current.txHash?.toLowerCase() ?? null;
  if (currentHash && currentHash !== transactionHash) {
    conflict('Governance action has already been confirmed with a different transaction hash', {
      actionId: input.actionId,
      existingTxHash: current.txHash,
      submittedTxHash: input.transactionHash,
    });
  }

  if (currentHash === transactionHash) {
    return { action: current, idempotent: true };
  }

  if (current.status !== 'prepared' && current.status !== 'broadcast_pending_verification') {
    conflict('Governance action is not eligible for broadcast confirmation', {
      actionId: input.actionId,
      status: current.status,
    });
  }

  const signing = ensurePreparedSigningPayload(current);
  if (
    current.audit.signerBindingId !== input.signerBindingId ||
    signing.signerWallet !== input.signerWallet ||
    signing.preparedPayloadHash !== input.preparedPayloadHash
  ) {
    conflict('Governance action changed while its broadcast was being verified', {
      actionId: input.actionId,
    });
  }

  if (
    !input.lateBroadcast &&
    current.status === 'prepared' &&
    current.expiresAt &&
    current.expiresAt <= input.committedAt
  ) {
    conflict('Prepared governance action expired before confirmation committed', {
      actionId: input.actionId,
      expiresAt: current.expiresAt,
    });
  }

  return {
    action: {
      ...input.transition,
      txHash: transactionHash,
    },
    idempotent: false,
  };
}

export function createInMemoryGovernanceTransitionStore(
  actionStore: GovernanceActionStore,
  auditLogStore: AuditLogStore,
): GovernanceTransitionStore {
  const leases = new Map<string, GovernanceMonitorClaim>();
  const versions = new Map<string, number>();
  let serial = Promise.resolve();

  async function atomically<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = serial;
    serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  return {
    commitConfirmation(input) {
      return atomically(async () => {
        const current = await actionStore.get(input.actionId);
        const resolved = resolveGovernanceConfirmationCommit(current, input);
        if (resolved.idempotent) return resolved.action;

        const listed = await actionStore.list({ limit: 10_000 });
        const duplicate = listed.items.find(
          (action) =>
            action.actionId !== input.actionId &&
            action.txHash?.toLowerCase() === input.transactionHash.toLowerCase(),
        );
        if (duplicate) {
          conflict('Transaction hash is already bound to another governance action', {
            actionId: input.actionId,
            conflictingActionId: duplicate.actionId,
          });
        }

        const stored = await actionStore.save(resolved.action);
        await auditLogStore.append(input.auditEntry);
        return stored;
      });
    },

    claimMonitorActions(input) {
      return atomically(async () => {
        const [pendingVerification, pendingConfirmation] = await Promise.all([
          actionStore.list({ status: 'broadcast_pending_verification', limit: input.limit }),
          actionStore.list({ status: 'broadcast', limit: input.limit }),
        ]);
        const candidates = [...pendingVerification.items, ...pendingConfirmation.items];
        const claims: GovernanceMonitorClaim[] = [];
        for (const action of candidates) {
          if (claims.length >= input.limit) break;
          const existing = leases.get(action.actionId);
          if (existing && existing.leaseExpiresAt > input.claimedAt) continue;
          const transitionVersion = (versions.get(action.actionId) ?? 0) + 1;
          versions.set(action.actionId, transitionVersion);
          const claim = {
            action,
            workerId: input.workerId,
            leaseToken: `${input.workerId}:${action.actionId}:${transitionVersion}`,
            transitionVersion,
            leaseExpiresAt: input.leaseExpiresAt,
          };
          leases.set(action.actionId, claim);
          claims.push(claim);
        }
        return claims;
      });
    },

    completeMonitorClaim(claim, transition, auditEntry, completedAt) {
      return atomically(async () => {
        const currentClaim = leases.get(claim.action.actionId);
        const current = await actionStore.get(claim.action.actionId);
        if (
          !currentClaim ||
          currentClaim.leaseToken !== claim.leaseToken ||
          currentClaim.workerId !== claim.workerId ||
          currentClaim.transitionVersion !== claim.transitionVersion ||
          currentClaim.leaseExpiresAt <= completedAt ||
          !current ||
          current.status !== claim.action.status ||
          current.txHash?.toLowerCase() !== claim.action.txHash?.toLowerCase()
        ) {
          return null;
        }
        const stored = await actionStore.save(transition);
        await auditLogStore.append(auditEntry);
        leases.delete(claim.action.actionId);
        versions.set(claim.action.actionId, claim.transitionVersion + 1);
        return stored;
      });
    },

    releaseMonitorClaim(claim) {
      return atomically(async () => {
        const current = leases.get(claim.action.actionId);
        if (!current || current.leaseToken !== claim.leaseToken) return false;
        leases.delete(claim.action.actionId);
        return true;
      });
    },
  };
}
