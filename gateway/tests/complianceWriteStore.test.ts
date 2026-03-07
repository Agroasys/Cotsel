/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AuditLogEntry } from '../src/core/auditLogStore';
import {
  ComplianceDecisionRecord,
  ComplianceStore,
  OracleProgressionBlockRecord,
} from '../src/core/complianceStore';
import { createPostgresComplianceWriteStore } from '../src/core/complianceWriteStore';

function buildDecision(overrides: Partial<ComplianceDecisionRecord> = {}): ComplianceDecisionRecord {
  return {
    decisionId: 'decision-1',
    tradeId: 'TRD-1',
    decisionType: 'KYT',
    result: 'DENY',
    reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
    provider: 'compliance-provider',
    providerRef: 'prov-ref-1',
    subjectId: 'subject-1',
    subjectType: 'counterparty',
    riskLevel: 'high',
    correlationId: 'corr-1',
    decidedAt: '2026-03-07T10:00:00.000Z',
    overrideWindowEndsAt: null,
    blockState: 'not_blocked',
    audit: {
      reason: 'Provider outage requires fail-closed compliance decision.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-900' }],
      ticketRef: 'AGRO-900',
      actorSessionId: 'sess-admin',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:00:00.000Z',
      requestedBy: 'uid-admin',
    },
    ...overrides,
  };
}

function buildBlock(overrides: Partial<OracleProgressionBlockRecord> = {}): OracleProgressionBlockRecord {
  return {
    tradeId: 'TRD-1',
    latestDecisionId: 'decision-1',
    blockState: 'blocked',
    reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
    requestId: 'req-1',
    correlationId: 'corr-1',
    audit: {
      reason: 'Hold oracle progression until provider recovers.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-901' }],
      ticketRef: 'AGRO-901',
      actorSessionId: 'sess-admin',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:02:00.000Z',
      requestedBy: 'uid-admin',
    },
    blockedAt: '2026-03-07T10:02:00.000Z',
    resumedAt: null,
    updatedAt: '2026-03-07T10:02:00.000Z',
    ...overrides,
  };
}

function buildAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    eventType: 'compliance.decision.recorded',
    route: '/api/dashboard-gateway/v1/compliance/decisions',
    method: 'POST',
    requestId: 'req-1',
    correlationId: 'corr-1',
    actorUserId: 'uid-admin',
    actorWalletAddress: '0x00000000000000000000000000000000000000aa',
    actorRole: 'admin',
    status: 'recorded',
    metadata: { decisionId: 'decision-1' },
    ...overrides,
  };
}

function createReadStore(): ComplianceStore {
  return {
    saveDecision: jest.fn(),
    getDecision: jest.fn(),
    getLatestDecision: jest.fn(),
    listTradeDecisions: jest.fn(),
    saveOracleProgressionBlock: jest.fn(),
    getOracleProgressionBlock: jest.fn(),
    getTradeStatus: jest.fn(),
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

  return { pool, query, release };
}

describe('createPostgresComplianceWriteStore', () => {
  test('rolls back decision persistence when audit insert fails', async () => {
    const store = createReadStore();
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // decision insert
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({}); // ROLLBACK

    const writeStore = createPostgresComplianceWriteStore(pool, store);

    await expect(writeStore.saveDecisionWithAudit(buildDecision(), buildAuditEntry())).rejects.toThrow('audit insert failed');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT'))).toBe(false);
    expect((store.getDecision as jest.Mock)).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rolls back block-state persistence when audit insert fails', async () => {
    const store = createReadStore();
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // block upsert
      .mockRejectedValueOnce(new Error('block audit insert failed'))
      .mockResolvedValueOnce({}); // ROLLBACK

    const writeStore = createPostgresComplianceWriteStore(pool, store);

    await expect(
      writeStore.saveBlockStateWithAudit(
        buildBlock(),
        buildAuditEntry({
          eventType: 'compliance.oracle_progression.blocked',
          route: '/api/dashboard-gateway/v1/compliance/trades/TRD-1/block-oracle-progression',
          status: 'blocked',
          metadata: { tradeId: 'TRD-1' },
        }),
      ),
    ).rejects.toThrow('block audit insert failed');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT'))).toBe(false);
    expect((store.getOracleProgressionBlock as jest.Mock)).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
