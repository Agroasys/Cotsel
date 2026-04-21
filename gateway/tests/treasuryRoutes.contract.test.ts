/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createTreasuryRouter } from '../src/routes/treasury';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { TreasuryReadReader } from '../src/core/treasuryReadService';
import type { TreasuryWorkflowClient } from '../src/core/treasuryWorkflowService';
import { sendInProcessRequest } from './support/inProcessHttp';

const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  commitSha: 'abc1234',
  buildTime: '2026-03-14T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const treasuryFixture = {
  state: {
    paused: false,
    claimsPaused: false,
    treasuryAddress: '0x0000000000000000000000000000000000000022',
    treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
    governanceApprovalsRequired: 2,
    governanceTimelockSeconds: 86400,
    requiredAdminCount: 2,
    claimableBalance: {
      assetSymbol: 'USDC',
      raw: '125000000',
      display: '125.0',
    },
    sweepVisibility: {
      canSweep: true,
      blockedReason: null,
    },
    payoutReceiverVisibility: {
      currentAddress: '0x0000000000000000000000000000000000000033',
      hasPendingUpdate: true,
      activeProposalIds: [11],
    },
  },
  freshness: {
    source: 'chain_rpc',
    sourceFreshAt: '2026-03-14T10:16:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

const treasuryActionsFixture = {
  items: [
    {
      actionId: 'gov-1',
      intentKey: 'v1|treasury_sweep|sweeptreasury||||31337|',
      proposalId: null,
      category: 'treasury_sweep',
      status: 'executed',
      contractMethod: 'sweepTreasury',
      txHash: '0xabc',
      blockNumber: 17,
      tradeId: null,
      chainId: '31337',
      targetAddress: null,
      createdAt: '2026-03-14T10:00:00.000Z',
      expiresAt: '2026-03-15T10:00:00.000Z',
      executedAt: '2026-03-14T10:01:00.000Z',
      requestId: 'req-1',
      correlationId: 'corr-1',
      errorCode: null,
      errorMessage: null,
      audit: {
        reason: 'Sweep treasury.',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-1' }],
        ticketRef: 'AGRO-1',
        actorSessionId: 'sess-1',
        actorWallet: '0x00000000000000000000000000000000000000a1',
        actorRole: 'admin',
        createdAt: '2026-03-14T10:00:00.000Z',
        requestedBy: 'uid-admin-1',
      },
    },
  ],
  nextCursor: null,
  freshness: {
    source: 'gateway_governance_ledger',
    sourceFreshAt: '2026-03-14T10:01:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

const accountingPeriodsFixture = [
  {
    id: 7,
    period_key: '2026-Q1',
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: '2026-03-31T23:59:59.000Z',
    status: 'OPEN',
    created_by: 'user:uid-admin',
    pending_close_at: null,
    close_reason: null,
    closed_by: null,
    closed_at: null,
    created_at: '2026-03-14T10:00:00.000Z',
    updated_at: '2026-03-14T10:00:00.000Z',
    metadata: {
      auditReason: 'Quarter close prep',
      auditTicketRef: 'FIN-100',
    },
  },
];

const sweepBatchFixture = {
  batch: {
    id: 11,
    batch_key: 'batch-q1-001',
    accounting_period_id: 7,
    accounting_period_key: '2026-Q1',
    accounting_period_status: 'OPEN',
    status: 'EXECUTED',
    asset_symbol: 'USDC',
    expected_total_raw: '125000000',
    matched_sweep_tx_hash: '0xsweep-1',
    matched_sweep_block_number: '101',
    matched_swept_at: '2026-03-31T12:00:00.000Z',
    payout_receiver_address: '0x0000000000000000000000000000000000000033',
    created_by: 'user:uid-admin',
    approved_by: 'user:uid-approver',
    closed_by: null,
    close_reason: null,
    created_at: '2026-03-31T11:00:00.000Z',
    updated_at: '2026-03-31T12:00:00.000Z',
    closed_at: null,
    metadata: {
      auditReason: 'Quarter close sweep',
      auditTicketRef: 'FIN-101',
    },
  },
  totals: {
    entryCount: 1,
    allocatedAmountRaw: '125000000',
  },
  entries: [
    {
      ledger_entry_id: 501,
      trade_id: 'trade-501',
      component_type: 'PLATFORM_FEE',
      amount_raw: '125000000',
      earned_at: '2026-03-31T10:00:00.000Z',
      payout_state: 'EXTERNAL_EXECUTION_CONFIRMED',
      accounting_period_id: 7,
      accounting_period_key: '2026-Q1',
      accounting_period_status: 'OPEN',
      sweep_batch_id: 11,
      sweep_batch_status: 'EXECUTED',
      allocation_status: 'ALLOCATED',
      matched_sweep_tx_hash: '0xsweep-1',
      matched_swept_at: '2026-03-31T12:00:00.000Z',
      partner_handoff_id: null,
      partner_name: null,
      partner_reference: null,
      partner_handoff_status: null,
      partner_completed_at: null,
      latest_fiat_deposit_state: 'FUNDED',
      latest_bank_payout_state: 'CONFIRMED',
      revenue_realization_status: null,
      realized_at: null,
      accounting_state: 'SWEPT',
      accounting_state_reason: 'Matched on-chain treasury claim recorded',
    },
  ],
  partnerHandoff: null,
};

const entryAccountingFixture = {
  ledger_entry_id: 501,
  trade_id: 'trade-501',
  component_type: 'PLATFORM_FEE',
  amount_raw: '125000000',
  earned_at: '2026-03-31T10:00:00.000Z',
  payout_state: 'EXTERNAL_EXECUTION_CONFIRMED',
  accounting_period_id: 7,
  accounting_period_key: '2026-Q1',
  accounting_period_status: 'OPEN',
  sweep_batch_id: 11,
  sweep_batch_status: 'EXECUTED',
  allocation_status: 'ALLOCATED',
  matched_sweep_tx_hash: '0xsweep-1',
  matched_swept_at: '2026-03-31T12:00:00.000Z',
  partner_handoff_id: null,
  partner_name: null,
  partner_reference: null,
  partner_handoff_status: null,
  partner_completed_at: null,
  latest_fiat_deposit_state: 'FUNDED',
  latest_bank_payout_state: 'CONFIRMED',
  revenue_realization_status: null,
  realized_at: null,
  accounting_state: 'SWEPT',
  accounting_state_reason: 'Matched on-chain treasury claim recorded',
};

const entryAccountingListFixture = [entryAccountingFixture];

const rollforwardFixture = {
  period: accountingPeriodsFixture[0],
  generated_at: '2026-03-31T23:59:59.000Z',
  opening_held_raw: '0',
  new_accruals_raw: '125000000',
  allocated_to_batches_raw: '125000000',
  swept_onchain_raw: '125000000',
  handed_off_raw: '0',
  realized_raw: '0',
  ending_held_raw: '0',
  unresolved_exception_raw: '0',
  blocking_issue_count: 0,
  warning_issue_count: 0,
  blocking_issues: [],
  warning_issues: [],
};

const closePacketFixture = {
  period: accountingPeriodsFixture[0],
  generated_at: '2026-03-31T23:59:59.000Z',
  ready_for_close: true,
  rollforward: rollforwardFixture,
  reconciliation: {
    status: 'CLEAR',
    freshness: 'FRESH',
    latest_completed_run_key: 'run-2026-q1',
    latest_completed_run_at: '2026-03-31T23:00:00.000Z',
    stale_running_run_count: 0,
    blocked_reasons: [],
  },
  batches: [
    {
      batch: sweepBatchFixture.batch,
      claim_event: {
        id: 91,
        source_event_id: 'claim-91',
        matched_sweep_batch_id: 11,
        tx_hash: '0xsweep-1',
        block_number: 101,
        observed_at: '2026-03-31T12:00:00.000Z',
        treasury_identity: '0xtreasury',
        payout_receiver: '0x0000000000000000000000000000000000000033',
        amount_raw: '125000000',
        triggered_by: '0xexecutor',
        created_at: '2026-03-31T12:00:00.000Z',
      },
      partner_handoff: null,
      totals: {
        expected_total_raw: '125000000',
        allocated_total_raw: '125000000',
        entry_count: 1,
      },
      entries: [
        {
          ledger_entry_id: 501,
          trade_id: 'trade-501',
          component_type: 'PLATFORM_FEE',
          source_amount_raw: '125000000',
          allocated_amount_raw: '125000000',
          earned_at: '2026-03-31T10:00:00.000Z',
          accounting_state: 'SWEPT',
          accounting_state_reason: 'Matched on-chain treasury claim recorded',
          matched_sweep_tx_hash: '0xsweep-1',
          matched_swept_at: '2026-03-31T12:00:00.000Z',
          partner_reference: null,
          partner_handoff_status: null,
          latest_bank_reference: null,
          latest_bank_payout_state: 'CONFIRMED',
          latest_bank_confirmed_at: '2026-03-31T13:00:00.000Z',
          revenue_realization_status: null,
          realized_at: null,
        },
      ],
      blocking_issues: [],
      warning_issues: [],
    },
  ],
  blocking_issues: [],
  warning_issues: [],
};

const batchTraceFixture = closePacketFixture.batches[0];

async function startServer(
  role: 'admin' | 'buyer' | null,
  options?: {
    config?: Partial<GatewayConfig>;
    treasuryRead?: Partial<TreasuryReadReader>;
    treasuryWorkflow?: Partial<TreasuryWorkflowClient>;
    session?: Partial<NonNullable<Awaited<ReturnType<AuthSessionClient['resolveSession']>>>>;
  },
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (role === null) {
        return null;
      }

      return {
        accountId: `acct-${role}`,
        userId: `uid-${role}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role,
        capabilities:
          role === 'admin'
            ? [
                'treasury:read',
                'treasury:prepare',
                'treasury:approve',
                'treasury:execute_match',
                'treasury:close',
              ]
            : [],
        signerAuthorizations:
          role === 'admin'
            ? [
                {
                  bindingId: 'binding-treasury-approve',
                  walletAddress: '0x00000000000000000000000000000000000000aa',
                  actionClass: 'treasury_approve',
                  environment: 'test',
                  approvedAt: '2026-03-14T00:00:00.000Z',
                  approvedBy: 'ops-admin-control',
                  ticketRef: 'FIN-900',
                  notes: null,
                },
                {
                  bindingId: 'binding-treasury-execute',
                  walletAddress: '0x00000000000000000000000000000000000000aa',
                  actionClass: 'treasury_execute',
                  environment: 'test',
                  approvedAt: '2026-03-14T00:00:00.000Z',
                  approvedBy: 'ops-admin-control',
                  ticketRef: 'FIN-901',
                  notes: null,
                },
                {
                  bindingId: 'binding-treasury-close',
                  walletAddress: '0x00000000000000000000000000000000000000aa',
                  actionClass: 'treasury_close',
                  environment: 'test',
                  approvedAt: '2026-03-14T00:00:00.000Z',
                  approvedBy: 'ops-admin-control',
                  ticketRef: 'FIN-902',
                  notes: null,
                },
              ]
            : [],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        ...(options?.session ?? {}),
      };
    }),
    checkReadiness: jest.fn(),
  };

  const treasuryReadService: TreasuryReadReader = {
    getTreasurySnapshot: jest.fn().mockResolvedValue(treasuryFixture),
    listTreasuryActions: jest.fn().mockResolvedValue(treasuryActionsFixture),
    ...(options?.treasuryRead ?? {}),
  };

  const treasuryWorkflowService: TreasuryWorkflowClient = {
    listAccountingPeriods: jest.fn().mockResolvedValue(accountingPeriodsFixture),
    listSweepBatches: jest.fn().mockResolvedValue([sweepBatchFixture.batch]),
    listEntryAccounting: jest.fn().mockResolvedValue(entryAccountingListFixture),
    getSweepBatch: jest.fn().mockResolvedValue(sweepBatchFixture),
    getEntryAccounting: jest.fn().mockResolvedValue(entryAccountingFixture),
    getAccountingPeriodRollforward: jest.fn().mockResolvedValue(rollforwardFixture),
    getAccountingPeriodClosePacket: jest.fn().mockResolvedValue(closePacketFixture),
    getSweepBatchTrace: jest.fn().mockResolvedValue(batchTraceFixture),
    createAccountingPeriod: jest.fn().mockResolvedValue(accountingPeriodsFixture[0]),
    requestAccountingPeriodClose: jest.fn().mockResolvedValue({
      ...accountingPeriodsFixture[0],
      status: 'PENDING_CLOSE',
    }),
    closeAccountingPeriod: jest.fn().mockResolvedValue({
      ...accountingPeriodsFixture[0],
      status: 'CLOSED',
      closed_by: 'user:uid-admin',
      closed_at: '2026-03-31T23:59:59.000Z',
    }),
    createSweepBatch: jest.fn().mockResolvedValue(sweepBatchFixture.batch),
    addSweepBatchEntry: jest.fn().mockResolvedValue({
      id: 21,
      sweep_batch_id: 11,
      ledger_entry_id: 501,
      entry_amount_raw: '125000000',
      allocation_status: 'ALLOCATED',
    }),
    requestSweepBatchApproval: jest.fn().mockResolvedValue({
      ...sweepBatchFixture.batch,
      status: 'PENDING_APPROVAL',
    }),
    approveSweepBatch: jest.fn().mockResolvedValue({
      ...sweepBatchFixture.batch,
      status: 'APPROVED',
      approved_by: 'user:uid-admin',
    }),
    markSweepBatchExecuted: jest.fn().mockResolvedValue(sweepBatchFixture.batch),
    recordPartnerHandoff: jest.fn().mockResolvedValue({
      id: 33,
      sweep_batch_id: 11,
      partner_name: 'licensed-partner',
      partner_reference: 'partner-ref-1',
      handoff_status: 'ACKNOWLEDGED',
    }),
    closeSweepBatch: jest.fn().mockResolvedValue({
      ...sweepBatchFixture.batch,
      status: 'CLOSED',
      closed_by: 'user:uid-admin',
      closed_at: '2026-03-31T23:00:00.000Z',
    }),
    createEntryRealization: jest.fn().mockResolvedValue({
      id: 44,
      ledger_entry_id: 501,
      accounting_period_id: 7,
      realization_status: 'REALIZED',
      realized_by: 'user:uid-admin',
      realized_at: '2026-03-31T23:15:00.000Z',
    }),
    ...(options?.treasuryWorkflow ?? {}),
  };

  const effectiveConfig = { ...config, ...(options?.config ?? {}) };
  const router = Router();
  router.use(
    createTreasuryRouter({
      authSessionClient,
      config: effectiveConfig,
      treasuryReadService,
      treasuryWorkflowService,
    }),
  );

  const app = createApp(effectiveConfig, {
    version: '0.1.0',
    commitSha: effectiveConfig.commitSha,
    buildTime: effectiveConfig.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  return app;
}

describe('gateway treasury routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateSnapshot = createSchemaValidator(
    spec,
    '#/components/schemas/TreasurySnapshotResponse',
  );
  const validateActions = createSchemaValidator(
    spec,
    '#/components/schemas/TreasuryActionListResponse',
  );
  const validateAccountingPeriods = createSchemaValidator(
    spec,
    '#/components/schemas/TreasuryAccountingPeriodListResponse',
  );
  const validateSweepBatch = createSchemaValidator(
    spec,
    '#/components/schemas/TreasurySweepBatchDetailResponse',
  );
  const validateEntryAccounting = createSchemaValidator(
    spec,
    '#/components/schemas/TreasuryEntryAccountingResponse',
  );
  const validateEntryAccountingList = createSchemaValidator(
    spec,
    '#/components/schemas/TreasuryEntryAccountingListResponse',
  );

  test('OpenAPI spec exposes treasury read endpoints', () => {
    expect(hasOperation(spec, 'get', '/treasury')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/actions')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/accounting-periods')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/accounting-periods/{periodId}/rollforward')).toBe(
      true,
    );
    expect(hasOperation(spec, 'get', '/treasury/accounting-periods/{periodId}/close-packet')).toBe(
      true,
    );
    expect(hasOperation(spec, 'get', '/treasury/sweep-batches')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/sweep-batches/{batchId}')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/sweep-batches/{batchId}/trace')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/entries/accounting')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/entries/{entryId}/accounting')).toBe(true);
    expect(hasOperation(spec, 'post', '/treasury/accounting-periods')).toBe(true);
    expect(hasOperation(spec, 'post', '/treasury/sweep-batches')).toBe(true);
    expect(hasOperation(spec, 'post', '/treasury/sweep-batches/{batchId}/approve')).toBe(true);
    expect(hasOperation(spec, 'post', '/treasury/sweep-batches/{batchId}/match-execution')).toBe(
      true,
    );
    expect(hasOperation(spec, 'post', '/treasury/sweep-batches/{batchId}/external-handoff')).toBe(
      true,
    );
    expect(hasOperation(spec, 'post', '/treasury/sweep-batches/{batchId}/partner-handoff')).toBe(
      true,
    );
    expect(hasOperation(spec, 'post', '/treasury/entries/{entryId}/realizations')).toBe(true);
  });

  test('GET /treasury returns a schema-valid treasury snapshot', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-treasury',
      },
    });
    const payload = response.json<{
      data: { state: { sweepVisibility: { canSweep: boolean } } };
    }>();

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-treasury');
    expect(validateSnapshot(payload)).toBe(true);
    expect(payload.data.state.sweepVisibility.canSweep).toBe(true);
  });

  test('GET /treasury/actions returns treasury governance history', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?category=treasury_sweep&status=executed&limit=20',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { items: Array<{ category: string }> } }>();

    expect(response.status).toBe(200);
    expect(validateActions(payload)).toBe(true);
    expect(payload.data.items[0].category).toBe('treasury_sweep');
  });

  test('GET treasury revenue-control reads return schema-valid payloads', async () => {
    const app = await startServer('admin');

    const periodsResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods?status=OPEN&limit=20&offset=0',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const periodsPayload = periodsResponse.json<{ data: unknown }>();
    expect(periodsResponse.status).toBe(200);
    expect(validateAccountingPeriods(periodsPayload)).toBe(true);

    const rollforwardResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods/7/rollforward',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(rollforwardResponse.status).toBe(200);

    const closePacketResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods/7/close-packet',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(closePacketResponse.status).toBe(200);

    const batchResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const batchPayload = batchResponse.json<{ data: unknown }>();
    expect(batchResponse.status).toBe(200);
    expect(validateSweepBatch(batchPayload)).toBe(true);

    const batchTraceResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/trace',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(batchTraceResponse.status).toBe(200);

    const entryListResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/entries/accounting?accountingState=SWEPT&limit=20&offset=0',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const entryListPayload = entryListResponse.json<{ data: unknown }>();
    expect(entryListResponse.status).toBe(200);
    expect(validateEntryAccountingList(entryListPayload)).toBe(true);

    const entryResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/entries/501/accounting',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const entryPayload = entryResponse.json<{ data: unknown }>();
    expect(entryResponse.status).toBe(200);
    expect(validateEntryAccounting(entryPayload)).toBe(true);
  });

  test('POST treasury revenue-control mutations require write access and structured audit payloads', async () => {
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      treasuryWorkflow: {
        createAccountingPeriod: jest.fn().mockResolvedValue(accountingPeriodsFixture[0]),
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        periodKey: '2026-Q2',
        startsAt: '2026-04-01T00:00:00.000Z',
        endsAt: '2026-06-30T23:59:59.000Z',
        audit: {
          reason: 'Open next revenue close period',
          ticketRef: 'FIN-200',
          evidenceReferences: ['evidence://ticket/FIN-200'],
          metadata: { source: 'contract-test' },
        },
      }),
    });

    expect(response.status).toBe(201);

    const blockedApp = await startServer('admin');
    const blockedResponse = await sendInProcessRequest(blockedApp, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        periodKey: '2026-Q2',
        startsAt: '2026-04-01T00:00:00.000Z',
        endsAt: '2026-06-30T23:59:59.000Z',
        audit: {
          reason: 'Open next revenue close period',
          ticketRef: 'FIN-200',
        },
      }),
    });

    expect(blockedResponse.status).toBe(403);
  });

  test('signer-required treasury actions accept a walletless session when an approved signer wallet is supplied explicitly', async () => {
    const markSweepBatchExecuted = jest.fn().mockResolvedValue({
      id: 11,
      status: 'EXECUTED',
      matched_sweep_tx_hash: '0xclaim',
    });
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      treasuryWorkflow: {
        markSweepBatchExecuted,
      },
      session: {
        walletAddress: null,
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/match-execution',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        signerWallet: '0x00000000000000000000000000000000000000aa',
        matchedSweepTxHash: '0xclaim',
        audit: {
          reason: 'Match chain-observed treasury claim evidence',
          ticketRef: 'FIN-201',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(markSweepBatchExecuted).toHaveBeenCalledTimes(1);
  });

  test('close-sensitive treasury actions require an approved treasury_close signer binding', async () => {
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      session: {
        signerAuthorizations: [
          {
            bindingId: 'binding-treasury-approve-only',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            actionClass: 'treasury_approve',
            environment: 'test',
            approvedAt: '2026-03-14T00:00:00.000Z',
            approvedBy: 'ops-admin-control',
            ticketRef: 'FIN-999',
            notes: null,
          },
        ],
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/accounting-periods/7/request-close',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        signerWallet: '0x00000000000000000000000000000000000000aa',
        audit: {
          reason: 'Request accounting period close after reconciliation clears',
          ticketRef: 'FIN-204',
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(response.json<{ error: { code: string } }>()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SIGNER_NOT_AUTHORIZED',
        }),
      }),
    );
  });

  test('execution-sensitive treasury handoff routes reject wallets without treasury_execute signer approval', async () => {
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      session: {
        signerAuthorizations: [
          {
            bindingId: 'binding-treasury-close-only',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            actionClass: 'treasury_close',
            environment: 'test',
            approvedAt: '2026-03-14T00:00:00.000Z',
            approvedBy: 'ops-admin-control',
            ticketRef: 'FIN-998',
            notes: null,
          },
        ],
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/external-handoff',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        signerWallet: '0x00000000000000000000000000000000000000aa',
        partnerName: 'licensed-counterparty',
        partnerReference: 'handoff-2',
        handoffStatus: 'ACKNOWLEDGED',
        audit: {
          reason: 'Record treasury partner handoff after execution evidence review',
          ticketRef: 'FIN-205',
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(response.json<{ error: { code: string } }>()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SIGNER_NOT_AUTHORIZED',
        }),
      }),
    );
  });

  test('treasury capability gates can narrow sensitive routes without changing session posture', async () => {
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      session: {
        capabilities: ['treasury:read', 'treasury:prepare'],
      },
    });

    const approveResponse = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/approve',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        signerWallet: '0x00000000000000000000000000000000000000aa',
        audit: {
          reason: 'Approve close-ready sweep batch',
          ticketRef: 'FIN-203',
        },
      }),
    });

    expect(approveResponse.status).toBe(403);
    expect(approveResponse.json<{ error: { code: string; message: string } }>()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'FORBIDDEN',
        }),
      }),
    );
  });

  test('explicit empty treasury capability sets do not fall back to full treasury scope', async () => {
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      session: {
        capabilities: [],
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        batchKey: '2026-Q2',
        accountingPeriodId: 7,
        assetSymbol: 'USDC',
        expectedTotalRaw: '125000000',
        audit: {
          reason: 'Prepare sweep batch',
          ticketRef: 'FIN-300',
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(response.json<{ error: { code: string; message: string } }>()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'FORBIDDEN',
          message: expect.stringContaining('Treasury capability'),
        }),
      }),
    );
  });

  test('canonical external handoff route and legacy alias both remain available', async () => {
    const recordPartnerHandoff = jest.fn().mockResolvedValue({
      id: 33,
      sweep_batch_id: 11,
      partner_name: 'licensed-counterparty',
      partner_reference: 'handoff-1',
      handoff_status: 'ACKNOWLEDGED',
    });
    const app = await startServer('admin', {
      config: {
        enableMutations: true,
        writeAllowlist: ['uid-admin'],
      },
      treasuryWorkflow: {
        recordPartnerHandoff,
      },
    });

    const requestBody = JSON.stringify({
      signerWallet: '0x00000000000000000000000000000000000000aa',
      partnerName: 'licensed-counterparty',
      partnerReference: 'handoff-1',
      handoffStatus: 'ACKNOWLEDGED',
      audit: {
        reason: 'Record external execution handoff evidence',
        ticketRef: 'FIN-202',
      },
    });

    const canonicalResponse = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/external-handoff',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    expect(canonicalResponse.status).toBe(200);

    const legacyResponse = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/treasury/sweep-batches/11/partner-handoff',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    expect(legacyResponse.status).toBe(200);
    expect(recordPartnerHandoff).toHaveBeenCalledTimes(2);
  });

  test('GET /treasury returns degraded payloads when the chain source is unavailable', async () => {
    const app = await startServer('admin', {
      treasuryRead: {
        getTreasurySnapshot: jest.fn().mockResolvedValue({
          state: null,
          freshness: {
            source: 'chain_rpc',
            sourceFreshAt: null,
            queriedAt: '2026-03-14T10:16:00.000Z',
            available: false,
            degradedReason: 'rpc unavailable',
          },
        }),
      },
    });

    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { freshness: { available: boolean } } }>();

    expect(response.status).toBe(200);
    expect(validateSnapshot(payload)).toBe(true);
    expect(payload.data.freshness.available).toBe(false);
  });

  test('treasury routes require an authenticated admin session and validate query parameters', async () => {
    const unauthenticatedApp = await startServer(null);
    const unauthenticatedResponse = await sendInProcessRequest(unauthenticatedApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const nonAdminApp = await startServer('buyer');
    const forbiddenResponse = await sendInProcessRequest(nonAdminApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: { authorization: 'Bearer sess-buyer' },
    });
    expect(forbiddenResponse.status).toBe(403);

    const app = await startServer('admin');
    const invalidCategory = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?category=broken',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidCategory.status).toBe(400);

    const invalidCursor = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?cursor=not-a-cursor',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidCursor.status).toBe(400);
  });
});
