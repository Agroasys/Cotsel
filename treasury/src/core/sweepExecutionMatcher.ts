import { config } from '../config';
import {
  getSweepBatchDetail,
  getTreasuryClaimEventByBatchId,
  getTreasuryClaimEventByTxHash,
  updateSweepBatchStatus,
  upsertTreasuryClaimEvent,
} from '../database/queries';
import { IndexerClient } from '../indexer/client';
import { SweepBatch } from '../types';
import { assertBatchExecutionMatchable } from './accountingPolicy';
import type { SettlementChainReader } from './chainCanonicality';
import { FinalizedTransactionVerifier } from './finalizedTransaction';
import { createSettlementProvider } from './settlementProvider';

type ClaimTransactionVerifier = Pick<FinalizedTransactionVerifier, 'verify'>;

interface SweepExecutionMatcherDeps {
  indexerClient?: Pick<IndexerClient, 'fetchTreasuryClaimEventByTxHash'>;
  claimVerifier?: ClaimTransactionVerifier;
}

export class SweepExecutionMatcherService {
  private readonly indexerClient: Pick<IndexerClient, 'fetchTreasuryClaimEventByTxHash'>;
  private readonly claimVerifier: ClaimTransactionVerifier;

  constructor(deps?: SweepExecutionMatcherDeps) {
    this.indexerClient = deps?.indexerClient ?? new IndexerClient(config.indexerGraphqlUrl);
    this.claimVerifier =
      deps?.claimVerifier ??
      new FinalizedTransactionVerifier({
        provider: createSettlementProvider() as unknown as SettlementChainReader | null,
      });
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

    const persistedClaimEvent = await getTreasuryClaimEventByTxHash(normalizedTxHash);
    const observedClaimEvent = persistedClaimEvent
      ? {
          id: persistedClaimEvent.source_event_id,
          eventName: 'TreasuryClaimed' as const,
          txHash: persistedClaimEvent.tx_hash,
          blockNumber: persistedClaimEvent.block_number,
          timestamp: persistedClaimEvent.observed_at,
          claimAmount: persistedClaimEvent.amount_raw,
          treasuryIdentity: persistedClaimEvent.treasury_identity,
          payoutReceiver: persistedClaimEvent.payout_receiver,
          triggeredBy: persistedClaimEvent.triggered_by,
        }
      : await this.indexerClient.fetchTreasuryClaimEventByTxHash(normalizedTxHash);
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

    // WP-4 B-08. The indexer is a copy of the chain, not the chain. A claim it
    // read from a block that has since been reorganized away would otherwise
    // mark the batch executed against a sweep that never happened.
    const claimVerdict = await this.claimVerifier.verify(
      observedClaimEvent.txHash,
      Number(observedClaimEvent.blockNumber),
    );
    if (!claimVerdict.finalized) {
      throw new Error(
        `TreasuryClaimed transaction is not finalized canonical evidence: ${claimVerdict.detail}`,
      );
    }

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
