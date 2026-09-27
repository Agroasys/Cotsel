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
  getTreasuryClaimEventByTxHash: jest.fn(),
  listSweepBatchEntryLogAddresses: jest.fn(),
  recordSweepBatchExecution: jest.fn(),
}));

import { SweepExecutionMatcherService } from '../src/core/sweepExecutionMatcher';
import * as queries from '../src/database/queries';
import { TEST_LOG_ADDRESS, TEST_OTHER_LOG_ADDRESS } from './helpers/chainCanonicality';
import {
  batchDetailFixture,
  CANONICAL_CLAIM_RECEIPT,
  claimedLog,
  claimVerifier,
  executedBatchFixture,
  indexedClaim,
  OTHER,
  PAYOUT,
  SIGNER,
  TREASURY,
} from './helpers/sweepExecution';

// WP-4 B-08. A claim executes a batch only when the chain itself proves it:
// the hash the operator supplied, the escrow's own TreasuryClaimed log, and one
// commit for the match and the transition.
describe('SweepExecutionMatcherService claim binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(queries.listSweepBatchEntryLogAddresses).mockResolvedValue([TEST_LOG_ADDRESS]);
    jest.mocked(queries.recordSweepBatchExecution).mockResolvedValue(executedBatchFixture as never);
  });

  describe('WP-4 B-08: the claim is bound to the supplied hash and the TreasuryClaimed log', () => {
    beforeEach(() => {
      jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
      jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);
      jest.mocked(queries.getTreasuryClaimEventByTxHash).mockResolvedValue(null);
    });

    async function expectRefused(options: {
      chain?: Parameters<typeof claimVerifier>[0];
      indexed?: typeof indexedClaim;
      reason: string;
    }) {
      const matcher = new SweepExecutionMatcherService({
        indexerClient: {
          fetchTreasuryClaimEventByTxHash: jest
            .fn()
            .mockResolvedValue(options.indexed ?? indexedClaim),
        },
        claimVerifier: claimVerifier(options.chain),
      });

      await expect(
        matcher.matchApprovedBatch({ batchId: 11, txHash: '0xclaim', actor: 'executor-3' }),
      ).rejects.toThrow(options.reason);
      expect(queries.recordSweepBatchExecution).not.toHaveBeenCalled();
    }

    it('refuses an indexed event that belongs to a different transaction', async () => {
      await expectRefused({
        indexed: { ...indexedClaim, txHash: '0xunrelated' },
        chain: { receipts: [{ ...CANONICAL_CLAIM_RECEIPT, txHash: '0xunrelated' }] },
        reason: 'does not belong to the supplied tx hash',
      });
    });

    it('refuses a successful transaction that carries no TreasuryClaimed log', async () => {
      await expectRefused({
        chain: {
          receipts: [
            {
              ...CANONICAL_CLAIM_RECEIPT,
              logTopics: [`0x${'ee'.repeat(32)}`],
              logData: '0x01',
            },
          ],
        },
        reason: 'carries 0 TreasuryClaimed logs',
      });
    });

    it('refuses a TreasuryClaimed log emitted by a contract other than the escrow', async () => {
      await expectRefused({
        chain: { receipts: [{ ...CANONICAL_CLAIM_RECEIPT, logAddress: TEST_OTHER_LOG_ADDRESS }] },
        reason: 'carries 0 TreasuryClaimed logs',
      });
    });

    it.each([
      ['amount', claimedLog({ amount: 1n })],
      ['payoutReceiver', claimedLog({ payoutReceiver: OTHER })],
    ])(
      'refuses when the on-chain claim differs from the indexed copy in %s',
      async (field, log) => {
        await expectRefused({
          chain: { receipts: [{ ...CANONICAL_CLAIM_RECEIPT, ...log }] },
          reason: `differs from the indexed claim in ${field}`,
        });
      },
    );

    it('refuses when the batch entries do not name a single emitter', async () => {
      jest
        .mocked(queries.listSweepBatchEntryLogAddresses)
        .mockResolvedValue([TEST_LOG_ADDRESS, TEST_OTHER_LOG_ADDRESS]);

      await expectRefused({ reason: 'do not resolve to a single settlement emitter' });
    });
  });

  describe('WP-4 B-08: a bound claim whose transition never committed is completed', () => {
    const boundClaim = {
      id: 90,
      source_event_id: 'event-90',
      matched_sweep_batch_id: 11,
      tx_hash: '0xclaim',
      block_number: 101,
      observed_at: new Date('2026-04-15T11:00:00.000Z'),
      treasury_identity: TREASURY,
      payout_receiver: PAYOUT,
      amount_raw: '125000000',
      triggered_by: SIGNER,
      created_at: new Date('2026-04-15T11:00:00.000Z'),
    };

    beforeEach(() => {
      jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(boundClaim);
      jest.mocked(queries.getTreasuryClaimEventByTxHash).mockResolvedValue(boundClaim);
    });

    it('re-verifies and executes a batch left APPROVED with its claim already bound', async () => {
      jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
      const matcher = new SweepExecutionMatcherService({
        indexerClient: { fetchTreasuryClaimEventByTxHash: jest.fn() },
        claimVerifier: claimVerifier(),
      });

      const result = await matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xclaim',
        actor: 'executor-3',
      });

      expect(result.status).toBe('EXECUTED');
      expect(queries.recordSweepBatchExecution).toHaveBeenCalledTimes(1);
    });

    it('does not complete a stranded batch whose claim no longer verifies', async () => {
      jest.mocked(queries.getSweepBatchDetail).mockResolvedValue(batchDetailFixture as never);
      const matcher = new SweepExecutionMatcherService({
        indexerClient: { fetchTreasuryClaimEventByTxHash: jest.fn() },
        claimVerifier: claimVerifier({ receipts: [] }),
      });

      await expect(
        matcher.matchApprovedBatch({ batchId: 11, txHash: '0xclaim', actor: 'executor-3' }),
      ).rejects.toThrow('has no receipt');
      expect(queries.recordSweepBatchExecution).not.toHaveBeenCalled();
    });

    it('returns an already executed batch without writing again', async () => {
      jest.mocked(queries.getSweepBatchDetail).mockResolvedValue({
        ...batchDetailFixture,
        batch: executedBatchFixture,
      } as never);
      const matcher = new SweepExecutionMatcherService({
        indexerClient: { fetchTreasuryClaimEventByTxHash: jest.fn() },
        claimVerifier: claimVerifier(),
      });

      const result = await matcher.matchApprovedBatch({
        batchId: 11,
        txHash: '0xclaim',
        actor: 'executor-3',
      });

      expect(result.status).toBe('EXECUTED');
      expect(queries.recordSweepBatchExecution).not.toHaveBeenCalled();
    });
  });
});
