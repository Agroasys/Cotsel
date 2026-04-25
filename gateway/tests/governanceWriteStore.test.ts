/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AuditLogEntry } from '../src/core/auditLogStore';
import {
  buildGovernanceIntentKey,
  GovernanceActionRecord,
  GovernanceActionStore,
} from '../src/core/governanceStore';
import {
  createPostgresGovernanceWriteStore,
  validateGovernanceActionInsertShape,
} from '../src/core/governanceWriteStore';

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
    flowType: 'executor',
    broadcastAt: null,
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

function splitSqlList(fragment: string): string[] {
  return fragment
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractGovernanceActionInsertShape(sql: string): {
  columns: string[];
  values: string[];
} {
  const columnMatch = sql.match(/INSERT INTO governance_actions\s*\(([\s\S]*?)\)\s*VALUES/i);
  const valueMatch = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/i);
  if (!columnMatch || !valueMatch) {
    throw new Error(`Failed to parse governance action upsert SQL: ${sql}`);
  }

  return {
    columns: splitSqlList(columnMatch[1]),
    values: splitSqlList(valueMatch[1]),
  };
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

    await expect(writeStore.saveActionWithAudit(buildAction(), buildAuditEntry())).rejects.toThrow(
      'audit insert failed',
    );

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(
      query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT')),
    ).toBe(false);
    expect(readStore.get as jest.Mock).not.toHaveBeenCalled();
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
    expect(
      query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('COMMIT')),
    ).toBe(false);
    expect(readStore.get as jest.Mock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('returns an existing open intent instead of inserting a duplicate queued action', async () => {
    const existing = buildAction({
      actionId: 'action-existing',
      status: 'requested',
    });
    const readStore = createReadStore();
    (readStore.get as jest.Mock).mockResolvedValueOnce(existing).mockResolvedValueOnce(existing);

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
      () =>
        buildAuditEntry({
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
    expect(
      query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO governance_actions'),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('persists a direct-sign prepared action with aligned governance_actions insert columns and values', async () => {
    const directSignAction = buildAction({
      actionId: 'action-direct-sign-1',
      status: 'prepared',
      flowType: 'direct_sign',
      finalSignerWallet: '0x00000000000000000000000000000000000000aa',
      verificationState: 'not_started',
      monitoringState: 'not_started',
      signing: {
        chainId: 31337,
        contractAddress: '0x0000000000000000000000000000000000000000',
        contractMethod: 'pause',
        args: [],
        signerWallet: '0x00000000000000000000000000000000000000aa',
        txRequest: {
          chainId: 31337,
          to: '0x0000000000000000000000000000000000000000',
          data: '0x8456cb59',
          value: '0',
        },
        preparedPayloadHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      audit: {
        ...buildAction().audit,
        actorAccountId: 'acct-admin',
        finalSignerWallet: '0x00000000000000000000000000000000000000aa',
        signerActionClass: 'governance',
        signerBindingId: 'binding-governance-admin',
        signerEnvironment: 'test',
      },
    });
    const readStore = createReadStore();
    (readStore.get as jest.Mock).mockResolvedValueOnce(directSignAction);

    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // existing action lookup
      .mockResolvedValueOnce({}) // governance upsert
      .mockResolvedValueOnce({}) // audit insert
      .mockResolvedValueOnce({}); // COMMIT

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);
    const result = await writeStore.saveDirectSignActionWithIntentDedupe(
      directSignAction,
      buildAuditEntry({
        eventType: 'governance.action.prepared',
        route: '/api/dashboard-gateway/v1/governance/pause/prepare',
        status: 'prepared',
        metadata: {
          actionId: directSignAction.actionId,
          signerWallet: directSignAction.finalSignerWallet,
        },
      }),
      () =>
        buildAuditEntry({
          eventType: 'governance.action.prepare_duplicate_reused',
          status: 'prepared',
          metadata: {
            actionId: directSignAction.actionId,
          },
        }),
      '2026-03-07T10:00:00.000Z',
    );

    expect(result.created).toBe(true);
    expect(result.action).toBe(directSignAction);

    const insertCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO governance_actions'),
    );
    expect(insertCall).toBeDefined();

    const [sql, params] = insertCall as [string, unknown[]];
    const { columns, values } = extractGovernanceActionInsertShape(sql);
    expect(values).toHaveLength(columns.length);
    expect(columns).toHaveLength(params.length + 1);
    expect(columns[columns.length - 1]).toBe('updated_at');
    expect(values[values.length - 1]).toBe('NOW()');

    expect(columns.slice(0, -1)).toEqual([
      'action_id',
      'intent_key',
      'intent_hash',
      'proposal_id',
      'category',
      'status',
      'flow_type',
      'contract_method',
      'tx_hash',
      'block_number',
      'trade_id',
      'chain_id',
      'target_address',
      'broadcast_at',
      'request_id',
      'correlation_id',
      'idempotency_key',
      'actor_id',
      'endpoint',
      'reason',
      'evidence_links',
      'ticket_ref',
      'actor_session_id',
      'actor_wallet',
      'actor_role',
      'requested_by',
      'approved_by',
      'actor_account_id',
      'final_signer_wallet',
      'verification_state',
      'verification_error',
      'verified_at',
      'monitoring_state',
      'prepared_signing_payload',
      'error_code',
      'error_message',
      'created_at',
      'expires_at',
      'executed_at',
    ]);

    columns.slice(0, -1).forEach((column, index) => {
      const expectedPlaceholder = `$${index + 1}`;
      const valueExpression = values[index];
      expect(
        valueExpression === expectedPlaceholder ||
          valueExpression === `${expectedPlaceholder}::jsonb`,
      ).toBe(true);
      if (['evidence_links', 'approved_by', 'prepared_signing_payload'].includes(column)) {
        expect(valueExpression).toBe(`${expectedPlaceholder}::jsonb`);
      }
    });
    expect(values[columns.indexOf('evidence_links')]).toBe('$21::jsonb');
    expect(values[columns.indexOf('approved_by')]).toBe('$27::jsonb');
    expect(values[columns.indexOf('prepared_signing_payload')]).toBe('$34::jsonb');
    expect(sql).toContain('prepared_signing_payload = EXCLUDED.prepared_signing_payload');
    expect(params[columns.indexOf('prepared_signing_payload')]).toEqual(
      JSON.stringify(directSignAction.signing),
    );
    expect(result.action.signing).toEqual(directSignAction.signing);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rejects governance action insert column/value count drift before PostgreSQL', () => {
    expect(() =>
      validateGovernanceActionInsertShape({
        columnCount: 39,
        parameterCount: 43,
        generatedValueCount: 44,
      }),
    ).toThrow('Governance action insert column/value mismatch');
  });
});
