/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-16: end to end, a treasury mutation is attributed to the principal
 * that authenticated it. A body-supplied `actor` is either redundant or a
 * forgery, and it is never what reaches the ledger.
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

// Service authentication has to be on for this suite, and `config` reads it at
// import time. Jest shares one process across suites, so the values are put
// back afterwards rather than left for whichever suite loads config next.
const savedEnv = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  API_KEYS_JSON: process.env.API_KEYS_JSON,
  TREASURY_INTERNAL_MUTATION_API_KEYS: process.env.TREASURY_INTERNAL_MUTATION_API_KEYS,
  TREASURY_OPERATOR_DELEGATION_API_KEYS: process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS,
};

process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS_JSON = JSON.stringify([
  { id: 'treasury-gateway', secret: 'secret-value', active: true },
  {
    id: 'treasury-checker',
    secret: 'secret-value-two',
    active: true,
    humanPrincipalId: 'finance.checker@agroasys',
  },
]);
process.env.TREASURY_INTERNAL_MUTATION_API_KEYS = 'treasury-gateway,treasury-checker';
// Only the dashboard gateway may act for an operator it authenticated.
process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS = 'treasury-gateway';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  updateSweepBatchStatus: jest.fn(),
  getSweepBatchDetail: jest.fn(),
  createAccountingPeriod: jest.fn(),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type QueriesModule = typeof import('../src/database/queries');

type MockResponse = Response & {
  status: jest.MockedFunction<(code: number) => MockResponse>;
  json: jest.MockedFunction<(body: unknown) => MockResponse>;
};

let LoadedTreasuryController: TreasuryControllerType;
let queriesModule: QueriesModule;

function mockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

function approvalRequest(apiKeyId: string, body: Record<string, unknown>, human?: string) {
  return {
    params: { batchId: '10' },
    body,
    serviceAuth: { apiKeyId, scheme: 'api_key', ...(human ? { humanPrincipalId: human } : {}) },
  } as unknown as Request<{ batchId: string }>;
}

describe('TreasuryController actor binding', () => {
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
    jest.clearAllMocks();

    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
      batch: {
        id: 10,
        status: 'PENDING_APPROVAL',
        expected_total_raw: '125000000',
        payout_receiver_address: '0xreceiver',
      },
      entries: [{ ledger_entry_id: 1 }],
      partnerHandoff: null,
      totals: { allocatedAmountRaw: '125000000', entryCount: 1 },
    } as unknown as Awaited<ReturnType<QueriesModule['getSweepBatchDetail']>>);
    jest
      .mocked(queriesModule.updateSweepBatchStatus)
      .mockResolvedValue({ id: 10, status: 'APPROVED' } as never);
  });

  test('approves under the human principal the API key is bound to', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(
      approvalRequest('treasury-checker', {}, 'finance.checker@agroasys'),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 10,
        status: 'APPROVED',
        actor: 'finance.checker@agroasys',
      }),
    );
  });

  test('refuses an approval that claims a different actor than the caller', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(
      approvalRequest(
        'treasury-checker',
        { actor: 'finance.maker@agroasys' },
        'finance.checker@agroasys',
      ),
      res,
    );

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'ActorMismatch',
        details: expect.objectContaining({ authenticatedActor: 'finance.checker@agroasys' }),
      }),
    );
  });

  test('records the gateway and the operator when a delegating caller names one', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(
      approvalRequest('treasury-gateway', { actor: 'user-42|0xabc|checker@agroasys' }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'service:treasury-gateway::user-42|0xabc|checker@agroasys',
      }),
    );
  });

  test('falls back to the service identity when no human is bound to the key', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(approvalRequest('treasury-gateway', {}), res);

    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'service:treasury-gateway' }),
    );
  });

  test('refuses to attribute a transition when no principal reached the handler', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(
      { params: { batchId: '10' }, body: {} } as unknown as Request<{ batchId: string }>,
      res,
    );

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'ActorUnauthenticated' }),
    );
  });

  test('binds the creator of an accounting period to the authenticated principal too', async () => {
    jest
      .mocked(queriesModule.createAccountingPeriod)
      .mockResolvedValue({ id: 3, period_key: '2026-Q2' } as never);

    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.createAccountingPeriod(
      {
        body: {
          periodKey: '2026-Q2',
          startsAt: '2026-04-01T00:00:00.000Z',
          endsAt: '2026-07-01T00:00:00.000Z',
          createdBy: 'somebody-else',
        },
        serviceAuth: {
          apiKeyId: 'treasury-checker',
          scheme: 'api_key',
          humanPrincipalId: 'finance.checker@agroasys',
        },
      } as unknown as Parameters<TreasuryControllerType['prototype']['createAccountingPeriod']>[0],
      res,
    );

    expect(queriesModule.createAccountingPeriod).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'ActorMismatch',
        message: expect.stringContaining('createdBy'),
      }),
    );
  });
});
