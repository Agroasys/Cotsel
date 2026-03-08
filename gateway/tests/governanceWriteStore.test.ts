/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AuditLogEntry } from '../src/core/auditLogStore';
import { buildGovernanceIntentKey, GovernanceActionRecord, GovernanceActionStore } from '../src/core/governanceStore';
import { createPostgresGovernanceWriteStore } from '../src/core/governanceWriteStore';

function buildAction(overrides: Partial<GovernanceActionRecord> = {}): GovernanceActionRecord {
  return {
    actionId: 'action-queue-1',
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
    expiresAt: '2026-03-08T10:00:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Enterprise operator requested a governance transition.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-777' }],
      ticketRef: 'AGRO-777',
      actorSessionId: 'sess-admin',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:00:00.000Z',
      requestedBy: 'uid-admin',
    },
    ...overrides,
  };
}

function buildAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    eventType: 'governance.action.queued',
    route: '/api/dashboard-gateway/v1/governance/pause',
    method: 'POST',
    requestId: 'req-1',
    correlationId: 'corr-1',
    actorUserId: 'uid-admin',
    actorWalletAddress: '0x00000000000000000000000000000000000000aa',
    actorRole: 'admin',
    status: 'requested',
    metadata: { actionId: 'action-queue-1' },
    ...overrides,
  };
}

function createReadStore(): GovernanceActionStore {
  return {
    get: jest.fn(),
    findOpenByIntentKey: jest.fn(),
    save: jest.fn(),
    list: jest.fn(),
    listRequestedExpired: jest.fn(),
    listActiveProposalIds: jest.fn(),
  };
}

function createPoolMocks() {
  const query = jest.fn();
  const release = jest.fn();
  const client = {
    query,
    release,
  } as unknown as PoolClient;
  const connect = jest.fn(async () => client);
  const pool = {
    connect,
  } as unknown as Pool;

  return { pool, connect, query, release };
}

describe('createPostgresGovernanceWriteStore', () => {
  test('rolls back queued action persistence when audit insert fails', async () => {
    const readStore = createReadStore();
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // governance upsert
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({}); // ROLLBACK

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);

    await expect(
      writeStore.saveActionWithAudit(buildAction(), buildAuditEntry()),
    ).rejects.toThrow('audit insert failed');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT'))).toBe(false);
    expect((readStore.get as jest.Mock)).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rolls back executor transition persistence when audit insert fails', async () => {
    const readStore = createReadStore();
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // governance upsert
      .mockRejectedValueOnce(new Error('executor audit insert failed'))
      .mockResolvedValueOnce({}); // ROLLBACK

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);

    await expect(
      writeStore.saveActionWithAudit(
        buildAction({
          actionId: 'action-exec-1',
          status: 'executed',
          txHash: '0xabc123',
          blockNumber: 88,
          executedAt: '2026-03-07T10:05:00.000Z',
        }),
        buildAuditEntry({
          eventType: 'governance.action.execution.succeeded',
          status: 'executed',
          metadata: {
            actionId: 'action-exec-1',
            txHash: '0xabc123',
            blockNumber: 88,
          },
        }),
      ),
    ).rejects.toThrow('executor audit insert failed');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT'))).toBe(false);
    expect((readStore.get as jest.Mock)).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('returns an existing open intent instead of inserting a duplicate queued action', async () => {
    const existing = buildAction({
      actionId: 'action-existing',
      status: 'requested',
    });
    const readStore = createReadStore();
    (readStore.get as jest.Mock)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing);

    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // advisory lock
      .mockResolvedValueOnce({ rows: [{ actionId: 'action-existing' }] }) // existing action lookup
      .mockResolvedValueOnce({}) // duplicate audit insert
      .mockResolvedValueOnce({}); // COMMIT

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);
    const result = await writeStore.saveQueuedActionWithIntentDedupe(
      buildAction({
        actionId: 'action-duplicate',
        intentKey: existing.intentKey,
      }),
      buildAuditEntry({
        metadata: {
          actionId: 'action-duplicate',
        },
      }),
      () => buildAuditEntry({
        eventType: 'governance.action.duplicate_reused',
        status: existing.status,
        metadata: {
          actionId: existing.actionId,
        },
      }),
      '2026-03-07T10:00:00.000Z',
    );

    expect(result.created).toBe(false);
    expect(result.action.actionId).toBe('action-existing');
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO governance_actions'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
