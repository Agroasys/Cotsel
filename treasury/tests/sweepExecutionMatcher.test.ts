process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  getSweepBatchDetail: jest.fn(),
  getTreasuryClaimEventByBatchId: jest.fn(),
  updateSweepBatchStatus: jest.fn(),
  upsertTreasuryClaimEvent: jest.fn(),
}));

import { SweepExecutionMatcherService } from '../src/core/sweepExecutionMatcher';
import * as queries from '../src/database/queries';

const batchDetailFixture = {
  batch: {
    id: 11,
    batch_key: 'batch-q2-001',
    accounting_period_id: 7,
    accounting_period_key: '2026-Q2',
    accounting_period_status: 'OPEN',
    asset_symbol: 'USDC',
    status: 'APPROVED',
    expected_total_raw: '125000000',
    payout_receiver_address: '0xpayout',
    approval_requested_at: new Date('2026-04-15T09:00:00.000Z'),
    approval_requested_by: 'operator-1',
    approved_at: new Date('2026-04-15T10:00:00.000Z'),
    approved_by: 'approver-2',
    matched_sweep_tx_hash: null,
    matched_sweep_block_number: null,
    matched_swept_at: null,
    executed_by: null,
    closed_at: null,
    closed_by: null,
    created_by: 'operator-1',
    metadata: {},
    created_at: new Date('2026-04-15T08:00:00.000Z'),
    updated_at: new Date('2026-04-15T10:00:00.000Z'),
  },
  entries: [],
  partnerHandoff: null,
  totals: {
    allocatedAmountRaw: '125000000',
    entryCount: 1,
  },
};

describe('SweepExecutionMatcherService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('matches execution only from authoritative TreasuryClaimed evidence', async () => {
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);
    jest.mocked(queries.upsertTreasuryClaimEvent).mockResolvedValue({
      id: 90,
      source_event_id: 'event-90',
      matched_sweep_batch_id: 11,
      tx_hash: '0xclaim',
      block_number: 101,
      observed_at: new Date('2026-04-15T11:00:00.000Z'),
      treasury_identity: '0xtreasury',
      payout_receiver: '0xpayout',
      amount_raw: '125000000',
      triggered_by: '0xsigner',
      created_at: new Date('2026-04-15T11:00:00.000Z'),
    });
    jest.mocked(queries.updateSweepBatchStatus).mockResolvedValue({
      ...batchDetailFixture.batch,
      status: 'EXECUTED',
      matched_sweep_tx_hash: '0xclaim',
      matched_sweep_block_number: '101',
      matched_swept_at: new Date('2026-04-15T11:00:00.000Z'),
      executed_by: 'executor-3',
    } as never);

    const matcher = new SweepExecutionMatcherService({
      indexerClient: {
        fetchTreasuryClaimEventByTxHash: jest.fn().mockResolvedValue({
          id: 'event-90',
          eventName: 'TreasuryClaimed',
          txHash: '0xclaim',
          blockNumber: 101,
          timestamp: new Date('2026-04-15T11:00:00.000Z'),
          claimAmount: '125000000',
          treasuryIdentity: '0xtreasury',
          payoutReceiver: '0xpayout',
          triggeredBy: '0xsigner',
        }),
      },
    });

    const result = await matcher.matchApprovedBatch({
      batchId: 11,
      txHash: '0xclaim',
      actor: 'executor-3',
    });

    expect(result.status).toBe('EXECUTED');
    expect(queries.upsertTreasuryClaimEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        matchedSweepBatchId: 11,
        txHash: '0xclaim',
        amountRaw: '125000000',
        payoutReceiver: '0xpayout',
      }),
    );
  });

  it('rejects unmatched tx hashes with no chain evidence', async () => {
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);

    const matcher = new SweepExecutionMatcherService({
      indexerClient: {
        fetchTreasuryClaimEventByTxHash: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xmissing',
        actor: 'executor-3',
      }),
    ).rejects.toThrow('No authoritative TreasuryClaimed event was found');
  });

  it('rejects claim events whose amount does not match the allocated batch total', async () => {
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);

    const matcher = new SweepExecutionMatcherService({
      indexerClient: {
        fetchTreasuryClaimEventByTxHash: jest.fn().mockResolvedValue({
          id: 'event-90',
          eventName: 'TreasuryClaimed',
          txHash: '0xclaim',
          blockNumber: 101,
          timestamp: new Date('2026-04-15T11:00:00.000Z'),
          claimAmount: '1',
          treasuryIdentity: '0xtreasury',
          payoutReceiver: '0xpayout',
          triggeredBy: '0xsigner',
        }),
      },
    });

    await expect(
      matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xclaim',
        actor: 'executor-3',
      }),
    ).rejects.toThrow('Observed treasury claim amount does not match allocated amount total');
  });

  it('rejects claim events whose destination does not match the batch payout receiver', async () => {
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);

    const matcher = new SweepExecutionMatcherService({
      indexerClient: {
        fetchTreasuryClaimEventByTxHash: jest.fn().mockResolvedValue({
          id: 'event-90',
          eventName: 'TreasuryClaimed',
          txHash: '0xclaim',
          blockNumber: 101,
          timestamp: new Date('2026-04-15T11:00:00.000Z'),
          claimAmount: '125000000',
          treasuryIdentity: '0xtreasury',
          payoutReceiver: '0xother',
          triggeredBy: '0xsigner',
        }),
      },
    });

    await expect(
      matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xclaim',
        actor: 'executor-3',
      }),
    ).rejects.toThrow(
      'Observed treasury claim destination does not match the batch payout receiver',
    );
  });

  it('rejects reuse of a different tx against an already matched batch', async () => {
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue({
      id: 90,
      source_event_id: 'event-90',
      matched_sweep_batch_id: 11,
      tx_hash: '0xclaim',
      block_number: 101,
      observed_at: new Date('2026-04-15T11:00:00.000Z'),
      treasury_identity: '0xtreasury',
      payout_receiver: '0xpayout',
      amount_raw: '125000000',
      triggered_by: '0xsigner',
      created_at: new Date('2026-04-15T11:00:00.000Z'),
    });

    const matcher = new SweepExecutionMatcherService({
      indexerClient: {
        fetchTreasuryClaimEventByTxHash: jest.fn(),
      },
    });

    await expect(
      matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xother',
        actor: 'executor-3',
      }),
    ).rejects.toThrow('Sweep batch is already matched to a different treasury claim tx');
  });
});
