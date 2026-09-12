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
  const signerWallet = '0x00000000000000000000000000000000000000aa';
  const intentKey = buildGovernanceIntentKey({
    category: 'pause',
    contractMethod: 'pause',
    chainId: '31337',
    approverWallet: signerWallet,
  });
  return {
    actionId: 'action-direct-sign-1',
    intentKey,
    intentHash: 'b'.repeat(64),
    proposalId: null,
    category: 'pause',
    status: 'prepared',
    flowType: 'direct_sign',
    contractMethod: 'pause',
    txHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    broadcastAt: null,
    createdAt: '2026-09-11T10:00:00.000Z',
    expiresAt: '2026-09-11T10:15:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    actorId: 'account:acct-admin',
    endpoint: '/api/dashboard-gateway/v1/governance/pause/prepare',
    errorCode: null,
    errorMessage: null,
    finalSignerWallet: null,
    verificationState: 'not_started',
    verificationError: null,
    verifiedAt: null,
    monitoringState: 'not_started',
    signing: {
      actionId: 'action-direct-sign-1',
      intentKey,
      actionType: 'pause',
      proposalId: null,
      expiresAt: '2026-09-11T10:15:00.000Z',
      auditReference: 'WP1-641',
      chainId: 31337,
      contractAddress: '0x00000000000000000000000000000000000000ff',
      contractMethod: 'pause',
      args: [],
      signerWallet,
      txRequest: {
        chainId: 31337,
        from: signerWallet,
        to: '0x00000000000000000000000000000000000000ff',
        data: '0x8456cb59',
        value: '0',
        nonce: 7,
      },
      preparedPayloadHash: 'a'.repeat(64),
    },
    audit: {
      reason: 'Prepare witnessed governance action for hardware-wallet signing.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/WP1-641' }],
      ticketRef: 'WP1-641',
      actorSessionId: 'sha256:session',
      actorAccountId: 'acct-admin',
      actorWallet: signerWallet,
      actorRole: 'admin',
      createdAt: '2026-09-11T10:00:00.000Z',
      requestedBy: 'uid-admin',
      signerBindingId: 'binding-admin-1',
      signerActionClass: 'governance',
      signerEnvironment: 'staging',
      signerPolicyResult: 'authorized',
      signerBindingWallet: signerWallet,
    },
    ...overrides,
  };
}

function buildAuditEntry(): AuditLogEntry {
  return {
    eventType: 'governance.action.prepared',
    route: '/api/dashboard-gateway/v1/governance/pause/prepare',
    method: 'POST',
    requestId: 'req-1',
    correlationId: 'corr-1',
    actionId: 'action-direct-sign-1',
    actorId: 'account:acct-admin',
    actorUserId: 'uid-admin',
    actorWalletAddress: '0x00000000000000000000000000000000000000aa',
    actorRole: 'admin',
    status: 'prepared',
  };
}

function createReadStore(): GovernanceActionStore {
  return {
    get: jest.fn(),
    findOpenByIntentKey: jest.fn(),
    save: jest.fn(),
    list: jest.fn(),
    listActiveProposalIds: jest.fn(),
  };
}

function createPoolMocks() {
  const query = jest.fn();
  const release = jest.fn();
  const client = { query, release } as unknown as PoolClient;
  return {
    pool: { connect: jest.fn(async () => client) } as unknown as Pool,
    query,
    release,
  };
}

function splitSqlList(fragment: string): string[] {
  return fragment
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

describe('createPostgresGovernanceWriteStore', () => {
  test('rolls back action persistence when the paired audit insert fails', async () => {
    const readStore = createReadStore();
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({});

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);
    await expect(writeStore.saveActionWithAudit(buildAction(), buildAuditEntry())).rejects.toThrow(
      'audit insert failed',
    );
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(readStore.get as jest.Mock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('persists a prepared action and its audit record atomically', async () => {
    const action = buildAction();
    const readStore = createReadStore();
    (readStore.get as jest.Mock).mockResolvedValueOnce(action);
    const { pool, query, release } = createPoolMocks();
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const writeStore = createPostgresGovernanceWriteStore(pool, readStore);
    const result = await writeStore.saveDirectSignActionWithIntentDedupe(
      action,
      buildAuditEntry(),
      () => ({ ...buildAuditEntry(), eventType: 'governance.action.duplicate_reused' }),
      action.createdAt,
    );

    expect(result).toEqual({ action, created: true });
    const insertCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO governance_actions'),
    ) as [string, unknown[]] | undefined;
    expect(insertCall).toBeDefined();
    const columnMatch = insertCall![0].match(
      /INSERT INTO governance_actions\s*\(([\s\S]*?)\)\s*VALUES/i,
    );
    const valueMatch = insertCall![0].match(/VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/i);
    expect(columnMatch).not.toBeNull();
    expect(valueMatch).not.toBeNull();
    const columns = splitSqlList(columnMatch![1]);
    const values = splitSqlList(valueMatch![1]);
    expect(values).toHaveLength(columns.length);
    expect(columns).toHaveLength(insertCall![1].length + 1);
    expect(insertCall![1][columns.indexOf('prepared_signing_payload')]).toBe(
      JSON.stringify(action.signing),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rejects insert shape drift before issuing SQL', () => {
    expect(() =>
      validateGovernanceActionInsertShape({
        columnCount: 39,
        parameterCount: 40,
        generatedValueCount: 41,
      }),
    ).toThrow('Governance action insert column/value mismatch');
  });
});
