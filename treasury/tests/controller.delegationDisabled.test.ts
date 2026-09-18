/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-16, review follow-up: identity delegation is an explicit exception.
 * With `TREASURY_OPERATOR_DELEGATION_API_KEYS` omitted, a key that is otherwise
 * trusted to mutate treasury still cannot assert an operator identity, so it
 * cannot manufacture distinct maker and checker actors and walk a batch through
 * approval on its own.
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
  { id: 'treasury-gateway', secret: 'secret-value', active: true },
]);
process.env.TREASURY_INTERNAL_MUTATION_API_KEYS = 'treasury-gateway';
// The exception is deliberately not configured.
delete process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS;

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  updateSweepBatchStatus: jest.fn(),
  getSweepBatchDetail: jest.fn(),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type QueriesModule = typeof import('../src/database/queries');

type MockResponse = Response & {
  status: jest.MockedFunction<(code: number) => MockResponse>;
  json: jest.MockedFunction<(body: unknown) => MockResponse>;
};

function mockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

describe('TreasuryController without configured delegation', () => {
  let LoadedTreasuryController: TreasuryControllerType;
  let queriesModule: QueriesModule;

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

  function approvalRequest(body: Record<string, unknown>) {
    return {
      params: { batchId: '10' },
      body,
      serviceAuth: { apiKeyId: 'treasury-gateway', scheme: 'api_key' },
    } as unknown as Request<{ batchId: string }>;
  }

  test('the delegation allowlist is empty unless a deployment names a caller', async () => {
    const { config } = await import('../src/config');

    expect(config.internalMutationApiKeys).toEqual(['treasury-gateway']);
    expect(config.operatorDelegationApiKeys).toEqual([]);
  });

  test('an internal mutation key cannot assert an operator identity', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.approveSweepBatch(approvalRequest({ actor: 'finance.checker@agroasys' }), res);

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'ActorMismatch',
        details: expect.objectContaining({ authenticatedActor: 'service:treasury-gateway' }),
      }),
    );
  });

  test('two operators behind one undelegated key collapse onto one actor', async () => {
    const controller = new LoadedTreasuryController();

    // Neither operator can name themselves, so both resolve to the same service
    // identity. Separation of duty then refuses the second transition rather
    // than accepting two transitions that only look like two people.
    for (const claimed of ['finance.maker@agroasys', 'finance.checker@agroasys']) {
      const res = mockResponse();
      await controller.approveSweepBatch(approvalRequest({ actor: claimed }), res);
      expect(res.status).toHaveBeenCalledWith(403);
    }

    const res = mockResponse();
    await controller.approveSweepBatch(approvalRequest({}), res);
    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'service:treasury-gateway' }),
    );
  });
});
