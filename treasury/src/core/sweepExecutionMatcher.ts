import { config } from '../config';
import {
  getSweepBatchDetail,
  getTreasuryClaimEventByBatchId,
  updateSweepBatchStatus,
  upsertTreasuryClaimEvent,
} from '../database/queries';
import { IndexerClient } from '../indexer/client';
import { SweepBatch } from '../types';
import { assertBatchExecutionMatchable } from './accountingPolicy';

interface SweepExecutionMatcherDeps {
  indexerClient?: Pick<IndexerClient, 'fetchTreasuryClaimEventByTxHash'>;
}

export class SweepExecutionMatcherService {
  private readonly indexerClient: Pick<IndexerClient, 'fetchTreasuryClaimEventByTxHash'>;

  constructor(deps?: SweepExecutionMatcherDeps) {
    this.indexerClient = deps?.indexerClient ?? new IndexerClient(config.indexerGraphqlUrl);
  }

  async matchApprovedBatch(params: {
    batchId: number;
    txHash: string;
    actor: string;
    metadata?: Record<string, unknown>;
  }): Promise<SweepBatch> {
    const detail = await getSweepBatchDetail(params.batchId);
    if (!detail) {
      throw new Error('Sweep batch not found');
    }

    const normalizedTxHash = params.txHash.trim().toLowerCase();
    const existingClaimEvent = await getTreasuryClaimEventByBatchId(params.batchId);
    if (existingClaimEvent) {
      if (existingClaimEvent.tx_hash.toLowerCase() !== normalizedTxHash) {
        throw new Error('Sweep batch is already matched to a different treasury claim tx');
      }

      return detail.batch;
    }

    const observedClaimEvent =
      await this.indexerClient.fetchTreasuryClaimEventByTxHash(normalizedTxHash);
    if (!observedClaimEvent) {
      throw new Error('No authoritative TreasuryClaimed event was found for the supplied tx hash');
    }

    assertBatchExecutionMatchable({
      batchStatus: detail.batch.status,
      payoutReceiverAddress: detail.batch.payout_receiver_address,
      assetSymbol: detail.batch.asset_symbol,
      expectedTotalRaw: detail.batch.expected_total_raw,
      allocatedTotalRaw: detail.totals.allocatedAmountRaw,
      observedTxHash: observedClaimEvent.txHash,
      observedPayoutReceiver: observedClaimEvent.payoutReceiver,
      observedAmountRaw: observedClaimEvent.claimAmount,
    });

    const claimEvent = await upsertTreasuryClaimEvent({
      sourceEventId: observedClaimEvent.id,
      matchedSweepBatchId: params.batchId,
      txHash: observedClaimEvent.txHash,
      blockNumber: observedClaimEvent.blockNumber,
      observedAt: observedClaimEvent.timestamp,
      treasuryIdentity: observedClaimEvent.treasuryIdentity,
      payoutReceiver: observedClaimEvent.payoutReceiver,
      amountRaw: observedClaimEvent.claimAmount,
      triggeredBy: observedClaimEvent.triggeredBy,
    });

    return updateSweepBatchStatus({
      batchId: params.batchId,
      status: 'EXECUTED',
      actor: params.actor,
      matchedSweepTxHash: claimEvent.tx_hash,
      matchedSweepBlockNumber: String(claimEvent.block_number),
      matchedSweptAt: claimEvent.observed_at,
      metadata: {
        ...(params.metadata ?? {}),
        matchedTreasuryClaimEventId: claimEvent.source_event_id,
      },
    });
  }
}
