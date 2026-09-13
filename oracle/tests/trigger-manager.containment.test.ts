import { TriggerManager } from '../src/core/trigger-manager';
import { buildContainmentGuard, type ContainmentGuard } from '../src/core/containment-guard';
import { ErrorType, Trigger, TriggerStatus, TriggerType } from '../src/types/trigger';
import type { OracleConfig } from '../src/types';
import { TradeContainedError, classifyError, determineNextStatus } from '../src/utils/errors';
import {
  createTrigger,
  getLatestTriggerByActionKey,
  getTriggerByIdempotencyKey,
  updateTrigger,
} from '../src/database/queries';

jest.mock('@agroasys/sdk', () => ({
  TradeStatus: { LOCKED: 0, IN_TRANSIT: 1, ARRIVAL_CONFIRMED: 2, FROZEN: 3, CLOSED: 4 },
}));

jest.mock('../src/database/queries', () => ({
  createTrigger: jest.fn(),
  getTriggerByIdempotencyKey: jest.fn(),
  getLatestTriggerByActionKey: jest.fn(),
  updateTrigger: jest.fn(),
}));

jest.mock('../src/metrics/counters', () => ({
  incrementOracleExhaustedRetries: jest.fn(),
  incrementOracleRedriveAttempts: jest.fn(),
  incrementOraclePendingApproval: jest.fn(),
  incrementOracleApproved: jest.fn(),
  incrementOracleRejected: jest.fn(),
}));

jest.mock('../src/utils/crypto', () => {
  const actual = jest.requireActual('../src/utils/crypto');
  return { ...actual, calculateBackoff: jest.fn(() => 0) };
});

const mockedCreateTrigger = createTrigger as jest.MockedFunction<typeof createTrigger>;
const mockedGetLatestTriggerByActionKey = getLatestTriggerByActionKey as jest.MockedFunction<
  typeof getLatestTriggerByActionKey
>;
const mockedGetTriggerByIdempotencyKey = getTriggerByIdempotencyKey as jest.MockedFunction<
  typeof getTriggerByIdempotencyKey
>;
const mockedUpdateTrigger = updateTrigger as jest.MockedFunction<typeof updateTrigger>;

type TriggerManagerSdkClient = ConstructorParameters<typeof TriggerManager>[0];
type TradeRecord = Awaited<ReturnType<TriggerManagerSdkClient['getTrade']>>;

const INCIDENT = 'RECON-20260912-AB12CD34';

function buildTrade(): TradeRecord {
  return {
    tradeId: '1',
    buyer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    supplier: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    // LOCKED: exactly the state a stage-one release is otherwise allowed from.
    status: 0,
    totalAmountLocked: 1000n,
    logisticsAmount: 100n,
    platformFeesAmount: 50n,
    supplierFirstTranche: 350n,
    supplierSecondTranche: 500n,
    ricardianHash: '0x' + '11'.repeat(32),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as TradeRecord;
}

function buildTrigger(status: TriggerStatus = TriggerStatus.PENDING): Trigger {
  return {
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

function buildSdkClient(): TriggerManagerSdkClient {
  return {
    getTrade: jest.fn().mockResolvedValue(buildTrade()),
    releaseFundsStage1: jest
      .fn()
      .mockResolvedValue({ txHash: '0x' + 'aa'.repeat(32), blockNumber: 123 }),
    confirmInspectionAvailable: jest.fn(),
    finalizeTrade: jest.fn(),
    // Not paused on chain: this is the window PRES-11 has to cover, between a
    // qualified discrepancy and an admin applying the scoped pause.
    isTradePaused: jest.fn().mockResolvedValue(false),
  } as unknown as TriggerManagerSdkClient;
}

/** A guard standing in for a reconciliation database holding one containment. */
function guardHolding(tradeIds: string[]): ContainmentGuard {
  return {
    assertMayProgress: jest.fn(async (tradeId: string) => {
      if (tradeIds.includes(tradeId)) {
        throw new TradeContainedError(
          tradeId,
          INCIDENT,
          `Trade ${tradeId} is under reconciliation containment ${INCIDENT} (CONTAINED) and must ` +
            'not progress until it is released',
        );
      }
    }),
    close: jest.fn(),
  };
}

describe('PRES-11 containment blocks the next progression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger());
    mockedUpdateTrigger.mockResolvedValue(undefined);
  });

  it('refuses a trade that is contained, even though it is unpaused and in the right state', async () => {
    const sdkClient = buildSdkClient();
    const manager = new TriggerManager(
      sdkClient,
      3,
      0,
      undefined,
      false,
      undefined,
      guardHolding(['1']),
    );

    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'req-1',
        triggerType: TriggerType.RELEASE_STAGE_1,
      }),
    ).rejects.toThrow(/reconciliation containment RECON-20260912-AB12CD34/);

    // The refusal happens before anything is submitted or even recorded.
    expect(sdkClient.releaseFundsStage1).not.toHaveBeenCalled();
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
  });

  it('lets an uncontained trade through', async () => {
    const sdkClient = buildSdkClient();
    const manager = new TriggerManager(
      sdkClient,
      3,
      0,
      undefined,
      false,
      undefined,
      guardHolding(['999']),
    );

    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(response.status).toBe(TriggerStatus.SUBMITTED);
    expect(sdkClient.releaseFundsStage1).toHaveBeenCalledWith('1');
  });

  it('refuses at the submission point when the containment opens after acceptance', async () => {
    // A trigger can be accepted, queued, retried and re-driven. What must be
    // stopped is the submission that is actually about to happen, not merely
    // the decision to attempt one, so the guard is re-asserted at the
    // chokepoint every progression goes through.
    const sdkClient = buildSdkClient();
    let contained = false;
    const guard: ContainmentGuard = {
      assertMayProgress: jest.fn(async (tradeId: string) => {
        if (contained) {
          throw new TradeContainedError(tradeId, INCIDENT, `Trade ${tradeId} is contained`);
        }
        // Contained by a reconciliation run between acceptance and submission.
        contained = true;
      }),
      close: jest.fn(),
    };

    const manager = new TriggerManager(sdkClient, 1, 0, undefined, false, undefined, guard);

    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    // Accepted, then refused at the submission point: the trigger exhausts its
    // attempts and lands in the state that pages an operator, rather than
    // submitting or being quietly written off.
    expect(response.status).toBe(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE);
    expect(response.message).toContain('is contained');
    expect(sdkClient.releaseFundsStage1).not.toHaveBeenCalled();
  });
});

describe('the containment guard is fail-closed', () => {
  it('refuses to progress when the containment table cannot be read', async () => {
    // Not knowing whether a trade is contained is not the same as knowing it is
    // clear to settle, so an unreachable reconciliation database stops
    // progressions rather than waving them through.
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:5432')),
      end: jest.fn(),
    };
    const guard = buildContainmentGuard({
      dbHost: 'postgres',
      dbPort: 5432,
      dbSslMode: 'disable',
      reconciliationDbName: 'cotsel_reconciliation',
      reconciliationDbUser: 'recon_runtime',
      reconciliationDbPassword: 'secret',
    } as unknown as OracleConfig);

    // Swap the pool the factory built for one that always fails.
    (guard as unknown as { pool: unknown }).pool = pool;

    await expect(guard.assertMayProgress('1')).rejects.toThrow(
      /Cannot confirm trade 1 is clear of a reconciliation containment/,
    );
    await guard.close();
  });

  it('permits everything, loudly, when no reconciliation database is configured', async () => {
    const guard = buildContainmentGuard({
      dbHost: 'postgres',
      dbPort: 5432,
      dbSslMode: 'disable',
    } as unknown as OracleConfig);

    await expect(guard.assertMayProgress('1')).resolves.toBeUndefined();
  });
});

describe('a containment is retryable, not a write-off', () => {
  it('classifies as retryable and escalates to a redrive rather than terminal failure', () => {
    // A containment is lifted by a governed unpause, so the milestone is still
    // owed. Exhausting the attempts pages an operator; a terminal failure would
    // quietly drop the trade's next step.
    const error = classifyError(new TradeContainedError('1', INCIDENT, 'contained'));

    expect(error).toBeInstanceOf(TradeContainedError);
    expect(error.isTerminal).toBe(false);
    expect(determineNextStatus(error, 3, 3)).toBe(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE);
  });
});
