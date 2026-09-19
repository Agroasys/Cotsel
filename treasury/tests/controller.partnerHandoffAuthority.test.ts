/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-11, at the route that moves a sweep batch.
 *
 * The batch used to advance to HANDED_OFF whenever it was EXECUTED, whatever
 * the provider had reported. Posting a `CREATED` or `FAILED` handoff therefore
 * marked value as handed off and opened realization behind it. The provider
 * state now has to mean the instruction actually left.
 */
import type { Response } from 'express';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

// `actorFor` resolves the principal from the authenticated service key, and
// `config` reads these at import time. Jest shares one process across suites,
// so they are restored rather than left for whichever suite loads config next.
const savedEnv = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  API_KEYS_JSON: process.env.API_KEYS_JSON,
  TREASURY_INTERNAL_MUTATION_API_KEYS: process.env.TREASURY_INTERNAL_MUTATION_API_KEYS,
};

process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS_JSON = JSON.stringify([
  {
    id: 'treasury-checker',
    secret: 'secret-value-two',
    active: true,
    humanPrincipalId: 'finance.checker@agroasys',
  },
]);
process.env.TREASURY_INTERNAL_MUTATION_API_KEYS = 'treasury-checker';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  updateSweepBatchStatus: jest.fn(),
  getSweepBatchDetail: jest.fn(),
  upsertPartnerHandoff: jest.fn(),
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

function handoffRequest(handoffStatus: string, evidenceReference?: string) {
  return {
    params: { batchId: '10' },
    body: {
      partnerName: 'bridge',
      partnerReference: 'bridge-ref-1',
      handoffStatus,
      ...(evidenceReference ? { evidenceReference } : {}),
    },
    serviceAuth: { apiKeyId: 'treasury-checker', scheme: 'api_key' },
  } as unknown as Parameters<TreasuryControllerType['prototype']['recordPartnerHandoff']>[0];
}

describe('TreasuryController external handoff authority', () => {
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  beforeAll(async () => {
    LoadedTreasuryController = (await import('../src/api/controller')).TreasuryController;
    queriesModule = await import('../src/database/queries');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
      batch: { id: 10, status: 'EXECUTED' },
      entries: [],
      partnerHandoff: null,
      totals: { allocatedAmountRaw: '0', entryCount: 0 },
    } as unknown as Awaited<ReturnType<QueriesModule['getSweepBatchDetail']>>);
    jest.mocked(queriesModule.upsertPartnerHandoff).mockResolvedValue({
      id: 7,
      partner_name: 'bridge',
      partner_reference: 'bridge-ref-1',
    } as never);
  });

  it.each(['CREATED', 'FAILED', 'RETURNED'])(
    'records a %s handoff without advancing the batch',
    async (handoffStatus) => {
      const controller = new LoadedTreasuryController();
      const res = mockResponse();

      await controller.recordPartnerHandoff(handoffRequest(handoffStatus), res);

      expect(res.status).toHaveBeenCalledWith(200);
      // The evidence is stored; the batch is not moved by it.
      expect(queriesModule.upsertPartnerHandoff).toHaveBeenCalledTimes(1);
      expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    },
  );

  it.each(['SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING'])(
    'advances the batch on a %s handoff',
    async (handoffStatus) => {
      const controller = new LoadedTreasuryController();
      const res = mockResponse();

      await controller.recordPartnerHandoff(handoffRequest(handoffStatus), res);

      expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: 10, status: 'HANDED_OFF' }),
      );
    },
  );

  it('advances the batch on a corroborated completion', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.recordPartnerHandoff(handoffRequest('COMPLETED', 'receipt-1'), res);

    expect(queriesModule.updateSweepBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'HANDED_OFF' }),
    );
  });

  it('refuses a provider state it has no authoritative mapping for', async () => {
    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.recordPartnerHandoff(handoffRequest('SETTLED'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queriesModule.upsertPartnerHandoff).not.toHaveBeenCalled();
    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
  });

  it('reports a frozen handoff as a conflict rather than a validation failure', async () => {
    const { PartnerHandoffConflictError } = await import('../src/core/treasuryPartnerHandoff');
    jest
      .mocked(queriesModule.upsertPartnerHandoff)
      .mockRejectedValue(new PartnerHandoffConflictError('frozen pending correction'));

    const controller = new LoadedTreasuryController();
    const res = mockResponse();

    await controller.recordPartnerHandoff(handoffRequest('COMPLETED', 'receipt-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
  });
});
