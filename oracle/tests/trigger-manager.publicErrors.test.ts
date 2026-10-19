/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-10 I-06: raw RPC, signer and provider text never leaves the oracle through
 * a live execution result, a replay of a stored failure, or the trigger list.
 */
import { fundedBindingFixture } from './helpers/fundedBinding';
import type { Request, Response } from 'express';
import { OracleController } from '../src/api/controller';
import { TriggerManager } from '../src/core/trigger-manager';
import { ErrorType, Trigger, TriggerStatus, TriggerType } from '../src/types/trigger';
import {
  listTriggers,
  createTrigger,
  getLatestTriggerByActionKey,
  getTriggerByIdempotencyKey,
  updateTrigger,
} from '../src/database/queries';

// These scenarios are about retry, idempotency and approval state, not about
// PRES-11 containment, so the gate is stubbed open. Its own behaviour — and the
// proof that a contained trade cannot progress — is in
// trigger-manager.containment.test.ts.
jest.mock('../src/core/containment-guard', () => ({
  createContainmentGuard: () => ({
    assertMayProgress: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('@agroasys/sdk', () => ({
  ...jest.requireActual('@agroasys/sdk'),
  TradeStatus: {
    LOCKED: 0,
    IN_TRANSIT: 1,
    ARRIVAL_CONFIRMED: 2,
    FROZEN: 3,
    CLOSED: 4,
  },
}));

jest.mock('../src/database/queries', () => ({
  listTriggers: jest.fn(),
  createTrigger: jest.fn(),
  getTriggerByIdempotencyKey: jest.fn(),
  getLatestTriggerByActionKey: jest.fn(),
  updateTrigger: jest.fn(),
}));

jest.mock('../src/metrics/counters', () => ({
  incrementOracleExhaustedRetries: jest.fn(),
  incrementOracleRedriveAttempts: jest.fn(),
}));

jest.mock('../src/utils/crypto', () => {
  const actual = jest.requireActual('../src/utils/crypto');
  return {
    ...actual,
    calculateBackoff: jest.fn(() => 0),
  };
});

const mockedCreateTrigger = createTrigger as jest.MockedFunction<typeof createTrigger>;
const mockedGetLatestTriggerByActionKey = getLatestTriggerByActionKey as jest.MockedFunction<
  typeof getLatestTriggerByActionKey
>;
const mockedGetTriggerByIdempotencyKey = getTriggerByIdempotencyKey as jest.MockedFunction<
  typeof getTriggerByIdempotencyKey
>;
const mockedUpdateTrigger = updateTrigger as jest.MockedFunction<typeof updateTrigger>;

const TRADE_STATUS_LOCKED = 0;
type TriggerManagerSdkClient = ConstructorParameters<typeof TriggerManager>[0];
type TradeRecord = Awaited<ReturnType<TriggerManagerSdkClient['getTrade']>>;

function buildTrade(status: number = TRADE_STATUS_LOCKED): TradeRecord {
  return {
    tradeId: '1',
    buyer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    supplier: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status,
    totalAmountLocked: 1000n,
    logisticsAmount: 100n,
    platformFeesAmount: 50n,
    supplierFirstTranche: 350n,
    supplierSecondTranche: 500n,
    ricardianHash: '0x' + '11'.repeat(32),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function buildTrigger(status: TriggerStatus = TriggerStatus.PENDING): Trigger {
  return {
    funded_binding: fundedBindingFixture(),
    id: 1,
    action_key: 'RELEASE_STAGE_1:1',
    request_id: 'req-1',
    idempotency_key: 'RELEASE_STAGE_1:1:req-1',
    trade_id: '1',
    trigger_type: TriggerType.RELEASE_STAGE_1,
    request_hash: null,
    attempt_count: 0,
    status,
    tx_hash: null,
    block_number: null,
    confirmation_stage: null,
    confirmation_stage_at: null,
    indexer_confirmed: false,
    indexer_confirmed_at: null,
    indexer_event_id: null,
    last_error: null,
    error_type: null as ErrorType | null,
    on_chain_verified: false,
    on_chain_verified_at: null,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    submitted_at: null,
    confirmed_at: null,
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

const RPC_URL = 'https://base-sepolia.example/v2/alchemy-key-0123';
// classifyError reads "Cannot finalize" as a domain refusal, but the text is the provider's.
const RAW_RPC_MESSAGE = `Cannot finalize: missing response (requestBody="{}", url="${RPC_URL}")`;
const LEAKS = ['alchemy-key', 'base-sepolia.example', 'requestBody'];

function expectNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const leaked of LEAKS) {
    expect(serialized).not.toContain(leaked);
  }
}

function sdkClientFailingWith(error: Error): TriggerManagerSdkClient {
  return {
    assertFundedBinding: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValue(error),
    getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
    releaseFundsStage1: jest.fn().mockRejectedValue(error),
    confirmInspectionAvailable: jest.fn(),
    finalizeTrade: jest.fn(),
    isTradePaused: jest.fn().mockResolvedValue(false),
  } as unknown as TriggerManagerSdkClient;
}

describe('oracle trigger failures expose no raw provider text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger(TriggerStatus.PENDING));
  });

  it('a live execution classified as validation from RPC text returns a stable message', async () => {
    const manager = new TriggerManager(sdkClientFailingWith(new Error(RAW_RPC_MESSAGE)), 3, 1);

    const response = await manager.executeTrigger({
      fundedBinding: fundedBindingFixture(),
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(response.status).toBe(TriggerStatus.TERMINAL_FAILURE);
    expect(response.message).toBe('Oracle validation failure; detail is recorded on the trigger');
    expectNoLeak(response);
    // Durable trigger metadata retains only the stable classification.
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        last_error: 'Oracle validation failure; detail is recorded on the trigger',
      }),
    );
  });

  it('an exhausted network failure returns a stable message', async () => {
    const manager = new TriggerManager(
      sdkClientFailingWith(new Error(`connect ETIMEDOUT ${RPC_URL}`)),
      1,
      0,
    );

    const response = await manager.executeTrigger({
      fundedBinding: fundedBindingFixture(),
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(response.status).toBe(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE);
    expect(response.message).toContain('Oracle network failure');
    expectNoLeak(response);
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        last_error: 'Oracle network failure; detail is recorded on the trigger',
      }),
    );
  });

  it('replaying a stored terminal failure returns only its classification', async () => {
    mockedGetTriggerByIdempotencyKey.mockResolvedValue({
      ...buildTrigger(TriggerStatus.TERMINAL_FAILURE),
      last_error: RAW_RPC_MESSAGE,
      error_type: ErrorType.VALIDATION,
    });
    const manager = new TriggerManager(sdkClientFailingWith(new Error('unused')), 3, 1);

    const response = await manager.executeTrigger({
      fundedBinding: fundedBindingFixture(),
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(response.status).toBe(TriggerStatus.TERMINAL_FAILURE);
    expect(response.message).toBe('Oracle validation failure; detail is recorded on the trigger');
    expectNoLeak(response);
  });

  it('the trigger list projects stored failures to their classification', async () => {
    (listTriggers as jest.MockedFunction<typeof listTriggers>).mockResolvedValue([
      {
        ...buildTrigger(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE),
        last_error: `Network request to ${RPC_URL} failed`,
        error_type: ErrorType.NETWORK,
      },
    ]);
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const controller = new OracleController({} as never);

    await controller.listTriggers(
      { query: {}, headers: {}, path: '/triggers' } as unknown as Request,
      { status, json } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0];
    expect(JSON.stringify(payload)).toContain(
      'Oracle network failure; detail is recorded on the trigger',
    );
    expectNoLeak(payload);
  });
});
