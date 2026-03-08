/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { AuditLogEntry } from './auditLogStore';
import {
  GovernanceActionRecord,
  GovernanceActionStore,
  isExpiredRequestedGovernanceAction,
} from './governanceStore';
import { GovernanceWriteStore } from './governanceWriteStore';

export interface GovernanceCleanupResult {
  requestId: string;
  applied: boolean;
  staleCount: number;
  actions: GovernanceActionRecord[];
  inspectedAt: string;
}

function buildStaleRecord(action: GovernanceActionRecord, inspectedAt: string): GovernanceActionRecord {
  return {
    ...action,
    status: 'stale',
    errorCode: 'QUEUE_EXPIRED',
    errorMessage: 'Governance action exceeded the requested queue TTL before execution',
    executedAt: inspectedAt,
  };
}

function buildAuditEntry(action: GovernanceActionRecord, requestId: string, inspectedAt: string): AuditLogEntry {
  return {
    eventType: 'governance.action.cleanup.stale',
    route: '/internal/cleanup/governance-actions',
    method: 'CLEANUP',
    requestId,
    correlationId: requestId,
    actorRole: 'system',
    status: 'stale',
    metadata: {
      actionId: action.actionId,
      intentKey: action.intentKey,
      inspectedAt,
      expiresAt: action.expiresAt,
      reasonCode: 'QUEUE_EXPIRED',
    },
  };
}

export class GovernanceCleanupService {
  constructor(
    private readonly store: GovernanceActionStore,
    private readonly writeStore: GovernanceWriteStore,
  ) {}

  async dryRun(now = new Date().toISOString(), limit = 100): Promise<GovernanceCleanupResult> {
    const actions = await this.store.listRequestedExpired(now, limit);

    return {
      requestId: `cleanup-preview-${randomUUID()}`,
      applied: false,
      staleCount: actions.length,
      actions,
      inspectedAt: now,
    };
  }

  async apply(now = new Date().toISOString(), limit = 100): Promise<GovernanceCleanupResult> {
    const requestId = `cleanup-${randomUUID()}`;
    const candidates = await this.store.listRequestedExpired(now, limit);
    const staleActions: GovernanceActionRecord[] = [];

    for (const candidate of candidates) {
      const current = await this.store.get(candidate.actionId);
      if (!current || !isExpiredRequestedGovernanceAction(current, now)) {
        continue;
      }

      staleActions.push(await this.writeStore.saveActionWithAudit(
        buildStaleRecord(current, now),
        buildAuditEntry(current, requestId, now),
      ));
    }

    return {
      requestId,
      applied: true,
      staleCount: staleActions.length,
      actions: staleActions,
      inspectedAt: now,
    };
  }
}
