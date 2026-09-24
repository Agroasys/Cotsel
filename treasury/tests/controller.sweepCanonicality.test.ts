/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / PRES-05: a sweep batch can never allocate, request approval for,
 * approve or close around a ledger entry the canonical chain no longer
 * contains. The controller re-derives eligibility before each decision, and a
 * refusal raised by the query layer's in-transaction check reaches the caller
 * as the same conflict.
 */
import type { Request, Response } from 'express';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

const savedEnv = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  API_KEYS_JSON: process.env.API_KEYS_JSON,
  TREASURY_INTERNAL_MUTATION_API_KEYS: process.env.TREASURY_INTERNAL_MUTATION_API_KEYS,
  TREASURY_OPERATOR_DELEGATION_API_KEYS: process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS,
};

process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS_JSON = JSON.stringify([
  {
    id: 'treasury-checker',
    secret: 'secret-value',
    active: true,
    humanPrincipalId: 'finance.checker@agroasys',
  },
]);
process.env.TREASURY_INTERNAL_MUTATION_API_KEYS = 'treasury-checker';
process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS = 'treasury-checker';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  addSweepBatchEntry: jest.fn(),
  getLedgerEntriesForEligibilityByIds: jest.fn(),
  getSweepBatchDetail: jest.fn(),
  updateSweepBatchStatus: jest.fn(),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type QueriesModule = typeof import('../src/database/queries');
type EligibilityModule = typeof import('../src/core/exportEligibility');
type SweepCanonicalityModule = typeof import('../src/core/sweepCanonicality');
type Eligibility = import('../src/types').TreasuryEntryEligibility;

type MockResponse = Response & {
  status: jest.MockedFunction<(code: number) => MockResponse>;
  json: jest.MockedFunction<(body: unknown) => MockResponse>;
};

let LoadedTreasuryController: TreasuryControllerType;
let queriesModule: QueriesModule;
let eligibilityModule: EligibilityModule;
let sweepCanonicalityModule: SweepCanonicalityModule;
let assessEntries: jest.SpyInstance;

function mockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

function batchRequest(body: Record<string, unknown> = {}) {
  return {
    params: { batchId: '10' },
    body,
    serviceAuth: {
      apiKeyId: 'treasury-checker',
      scheme: 'api_key',
      humanPrincipalId: 'finance.checker@agroasys',
    },
  } as unknown as Request<{ batchId: string }>;
}

function gate(entryId: number, overrides: Partial<Eligibility>): Eligibility {
  return {
    entryId,
    tradeId: `trade-${entryId}`,
    payoutState: 'PENDING_REVIEW',
    confirmationStage: 'FINALIZED',
    latestBlockNumber: 600,
    safeBlockNumber: 550,
    finalizedBlockNumber: 500,
    reconciliationStatus: 'CLEAR',
    reconciliationRunKey: 'run-1',
    reconciliationFreshness: 'FRESH',
    reconciliationCompletedAt: null,
    staleRunningRunCount: 0,
    reconciliationCoverageToBlock: 500,
    reconciliationCoverageComplete: true,
    canonicalityState: 'CANONICAL',
    canonicalityDepth: null,
    canonicalityStableBlockNumber: 500,
    eligibleForPayout: true,
    eligibleForExport: false,
    blockedReasons: [],
    ...overrides,
  } as Eligibility;
}

const ORPHANED = {
  canonicalityState: 'ORPHANED' as const,
  eligibleForPayout: false,
  blockedReasons: ['Entry was orphaned by a chain reorganization'],
};

function mockBatch(status: string, extra: Record<string, unknown> = {}) {
  jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
    batch: {
      id: 10,
      status,
      expected_total_raw: '250',
      payout_receiver_address: '0xreceiver',
    },
    entries: [
      { ledger_entry_id: 1, allocation_status: 'ALLOCATED', accounting_state: 'REALIZED' },
      { ledger_entry_id: 2, allocation_status: 'ALLOCATED', accounting_state: 'REALIZED' },
    ],
    partnerHandoff: { handoff_status: 'COMPLETED' },
    totals: { allocatedAmountRaw: '250', entryCount: 2 },
    ...extra,
  } as unknown as Awaited<ReturnType<QueriesModule['getSweepBatchDetail']>>);
}

function mockGates(...gates: Eligibility[]) {
  assessEntries.mockResolvedValue(new Map(gates.map((item) => [item.entryId, item])));
}

describe('TreasuryController sweep canonicality gate', () => {
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  beforeEach(async () => {
    jest.resetModules();
    ({ TreasuryController: LoadedTreasuryController } = await import('../src/api/controller'));
    queriesModule = await import('../src/database/queries');
    eligibilityModule = await import('../src/core/exportEligibility');
    sweepCanonicalityModule = await import('../src/core/sweepCanonicality');
    jest.clearAllMocks();

    assessEntries = jest.spyOn(
      eligibilityModule.TreasuryEligibilityService.prototype,
      'assessEntries',
    );
    jest
      .mocked(queriesModule.getLedgerEntriesForEligibilityByIds)
      .mockImplementation(
        async (ids: number[]) =>
          ids.map((id) => ({ id, trade_id: `trade-${id}` })) as unknown as Awaited<
            ReturnType<QueriesModule['getLedgerEntriesForEligibilityByIds']>
          >,
      );
    jest
      .mocked(queriesModule.updateSweepBatchStatus)
      .mockImplementation(
        async (data) =>
          ({ id: 10, status: data.status }) as unknown as Awaited<
            ReturnType<QueriesModule['updateSweepBatchStatus']>
          >,
      );
  });

  afterEach(() => {
    assessEntries.mockRestore();
  });

  test('refuses to allocate an orphaned entry before touching the batch', async () => {
    mockGates(gate(7, ORPHANED));
    const res = mockResponse();

    await new LoadedTreasuryController().addSweepBatchEntry(
      batchRequest({ ledgerEntryId: 7 }) as never,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'SweepEligibilityBlocked',
        details: {
          entries: [expect.objectContaining({ entryId: 7, canonicalityState: 'ORPHANED' })],
        },
      }),
    );
    expect(queriesModule.addSweepBatchEntry).not.toHaveBeenCalled();
  });

  test('refuses to allocate a canonical entry that is not yet cleared for payout', async () => {
    mockGates(
      gate(7, {
        reconciliationStatus: 'BLOCKED',
        eligibleForPayout: false,
        blockedReasons: ['Reconciliation run is stale'],
      }),
    );
    const res = mockResponse();

    await new LoadedTreasuryController().addSweepBatchEntry(
      batchRequest({ ledgerEntryId: 7 }) as never,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(queriesModule.addSweepBatchEntry).not.toHaveBeenCalled();
  });

  test('allocates an entry that is cleared for payout', async () => {
    mockGates(gate(7, {}));
    jest
      .mocked(queriesModule.addSweepBatchEntry)
      .mockResolvedValue({ id: 1, ledger_entry_id: 7 } as never);
    const res = mockResponse();

    await new LoadedTreasuryController().addSweepBatchEntry(
      batchRequest({ ledgerEntryId: 7 }) as never,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(assessEntries).toHaveBeenCalledWith([expect.objectContaining({ id: 7 })]);
  });

  test.each([
    ['requestSweepBatchApproval', 'DRAFT'],
    ['approveSweepBatch', 'PENDING_APPROVAL'],
  ] as const)('%s refuses while any allocated entry is orphaned', async (handler, status) => {
    mockBatch(status);
    mockGates(gate(1, {}), gate(2, ORPHANED));
    const res = mockResponse();

    await new LoadedTreasuryController()[handler](batchRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SweepEligibilityBlocked' }),
    );
    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
  });

  test('approves once every allocated entry is cleared for payout', async () => {
    mockBatch('PENDING_APPROVAL');
    mockGates(gate(1, {}), gate(2, {}));
    const res = mockResponse();

    await new LoadedTreasuryController().approveSweepBatch(batchRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED' }),
    );
  });

  test('refuses to close a batch whose entry was orphaned after execution', async () => {
    mockBatch('HANDED_OFF');
    mockGates(gate(1, {}), gate(2, ORPHANED));
    const res = mockResponse();

    await new LoadedTreasuryController().closeSweepBatch(batchRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SweepEligibilityBlocked',
        message: 'Sweep batch ledger entries are no longer proven canonical',
      }),
    );
    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
  });

  test('close requires canonicality, not the pre-execution payout gate', async () => {
    mockBatch('HANDED_OFF');
    // Paid-out entries no longer satisfy every payout condition; close only
    // asks whether the chain still contains them.
    mockGates(
      gate(1, { eligibleForPayout: false, blockedReasons: ['bank confirmation pending'] }),
      gate(2, { eligibleForPayout: false, blockedReasons: ['bank confirmation pending'] }),
    );
    const res = mockResponse();

    await new LoadedTreasuryController().closeSweepBatch(batchRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CLOSED' }),
    );
  });

  test('an orphaning that lands between the check and the write is still a conflict', async () => {
    mockBatch('PENDING_APPROVAL');
    mockGates(gate(1, {}), gate(2, {}));
    jest
      .mocked(queriesModule.updateSweepBatchStatus)
      .mockRejectedValue(
        new sweepCanonicalityModule.SweepCanonicalityError(
          'Sweep batch ledger entries are not proven canonical: 2 (ORPHANED)',
          [2],
        ),
      );
    const res = mockResponse();

    await new LoadedTreasuryController().approveSweepBatch(batchRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SweepEligibilityBlocked',
        details: { entryIds: [2] },
      }),
    );
  });
});
