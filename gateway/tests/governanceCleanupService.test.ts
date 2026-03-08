/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GovernanceCleanupService } from '../src/core/governanceCleanupService';
import {
  buildGovernanceIntentKey,
  createInMemoryGovernanceActionStore,
  GovernanceActionRecord,
} from '../src/core/governanceStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';

function buildAction(overrides: Partial<GovernanceActionRecord> = {}): GovernanceActionRecord {
  return {
    actionId: 'action-1',
    intentKey: buildGovernanceIntentKey({
      category: 'pause',
      contractMethod: 'pause',
      chainId: '31337',
    }),
    proposalId: null,
    category: 'pause',
    status: 'requested',
    contractMethod: 'pause',
    txHash: null,
    extrinsicHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    createdAt: '2026-03-07T10:00:00.000Z',
    expiresAt: '2026-03-07T10:05:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Queue governance action for controlled operator handling.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-500' }],
      ticketRef: 'AGRO-500',
      actorSessionId: 'sess-admin',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:00:00.000Z',
      requestedBy: 'uid-admin',
    },
    ...overrides,
  };
}

describe('GovernanceCleanupService', () => {
  test('dry run lists stale requested actions without mutating them', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction(),
      buildAction({
        actionId: 'action-fresh',
        expiresAt: '2026-03-08T10:05:00.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceCleanupService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
    );

    const result = await service.dryRun('2026-03-07T10:06:00.000Z');

    expect(result.applied).toBe(false);
    expect(result.staleCount).toBe(1);
    expect(result.actions.map((action) => action.actionId)).toEqual(['action-1']);
    expect(auditLogStore.entries).toHaveLength(0);
    expect((await store.get('action-1'))?.status).toBe('requested');
  });

  test('apply marks stale requested actions and audits the cleanup', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceCleanupService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
    );

    const result = await service.apply('2026-03-07T10:06:00.000Z');
    const updated = await store.get('action-1');

    expect(result.applied).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(updated?.status).toBe('stale');
    expect(updated?.errorCode).toBe('QUEUE_EXPIRED');
    expect(auditLogStore.entries).toHaveLength(1);
    expect(auditLogStore.entries[0].eventType).toBe('governance.action.cleanup.stale');
  });

  test('apply is idempotent after stale actions have already been marked', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceCleanupService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
    );

    const first = await service.apply('2026-03-07T10:06:00.000Z');
    const second = await service.apply('2026-03-07T10:07:00.000Z');

    expect(first.staleCount).toBe(1);
    expect(second.staleCount).toBe(0);
    expect(auditLogStore.entries).toHaveLength(1);
  });
});
