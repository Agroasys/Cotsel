/** Controlled provider fixture. The reconciliation service and persistence are real. */
import './reconciliationEnv';
import { TradeStatus } from '@agroasys/sdk';
import { OnchainClient } from '../../blockchain/client';
import { IndexerClient } from '../../indexer/client';
import { ReconciliationService } from '../../core/reconciler';

const hash = `0x${'ab'.repeat(32)}`;
const buyer = '0x1111111111111111111111111111111111111111';
const supplier = '0x2222222222222222222222222222222222222222';
const height = Number(process.env.CRASH_TEST_HEIGHT);
OnchainClient.prototype.resolveBoundary = async () => ({
  blockNumber: height,
  blockHash: hash,
  tag: 'finalized',
  chainTradeCounter: 8n,
  indexerProcessedBlock: height,
  finalityBlockNumber: height,
  indexerAhead: false,
});
OnchainClient.prototype.getTrade = async (tradeId) => ({
  tradeId,
  buyer,
  supplier,
  status: TradeStatus.LOCKED,
  totalAmountLocked: 1000000n,
  logisticsAmount: 0n,
  platformFeesAmount: 0n,
  supplierFirstTranche: 600000n,
  supplierSecondTranche: 400000n,
  ricardianHash: hash,
  createdAt: new Date('2026-09-01T00:00:00Z'),
});
IndexerClient.prototype.fetchProcessedBlock = async () => height;
IndexerClient.prototype.fetchTradeCount = async () => 8;
IndexerClient.prototype.fetchTradeIdUpperBound = async () => 'f7';
IndexerClient.prototype.fetchTradesByIds = async (ids) =>
  ids.map((tradeId) => ({
    tradeId,
    buyer,
    supplier,
    status: 'LOCKED',
    totalAmountLocked: 1000000n,
    logisticsAmount: 0n,
    platformFeesAmount: 0n,
    platformFeeNetAmount: 0n,
    settlementSupportFeeAmount: 0n,
    supplierFirstTranche: 600000n,
    supplierSecondTranche: 400000n,
    ricardianHash: hash,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    arrivalTimestamp: null,
  }));
IndexerClient.prototype.fetchTradeIdsPage = async (input) => {
  process.send?.({ event: 'PAGE_READ', afterId: input.afterId });
  return new Promise(() => {});
};
void new ReconciliationService().reconcileOnce('ONCE', 'crash-review').catch(() => {
  process.exitCode = 1;
  process.disconnect?.();
});
