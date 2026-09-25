import { config } from '../config';
import {
  getSweepBatchDetail,
  getTreasuryClaimEventByBatchId,
  getTreasuryClaimEventByTxHash,
  listSweepBatchEntryLogAddresses,
  recordSweepBatchExecution,
} from '../database/queries';
import { IndexerClient } from '../indexer/client';
import { SweepBatch } from '../types';
import { assertBatchExecutionMatchable } from './accountingPolicy';
import { FinalizedTransactionVerifier } from './finalizedTransaction';
import { createSettlementProvider } from './settlementProvider';
import { verifyTreasuryClaimLog } from './treasuryClaimLog';

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
        provider: createSettlementProvider(),
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

      // A claim bound by a match whose transition never committed is finished
      // below rather than reported as done with the batch still APPROVED.
      if (detail.batch.status !== 'APPROVED') {
        return detail.batch;
      }
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

    // Everything below is checked against this event, so it has to be the one
    // the caller asked about and not whatever the indexer returned.
    if (observedClaimEvent.txHash.trim().toLowerCase() !== normalizedTxHash) {
      throw new Error('Indexed TreasuryClaimed event does not belong to the supplied tx hash');
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

    // The claim can only have come from the escrow that accrued the fees the
    // batch sweeps, so the batch's own entries name the expected emitter.
    const emitters = await listSweepBatchEntryLogAddresses(params.batchId);
    const [emitter] = emitters;
    if (emitters.length !== 1 || !emitter) {
      throw new Error(
        'Sweep batch entries do not resolve to a single settlement emitter, so the claim log cannot be bound to the batch',
      );
    }

    // WP-4 B-08. The indexer is a copy of the chain, not the chain. A claim it
    // read from a block that has since been reorganized away would otherwise
    // mark the batch executed against a sweep that never happened.
    const claimVerdict = await this.claimVerifier.verify(
      normalizedTxHash,
      Number(observedClaimEvent.blockNumber),
    );
    if (!claimVerdict.finalized) {
      throw new Error(
        `TreasuryClaimed transaction is not finalized canonical evidence: ${claimVerdict.detail}`,
      );
    }

    // A finalized receipt proves a transaction landed, not that it was this
    // claim. The event itself is decoded from the receipt and must agree.
    const claimLog = verifyTreasuryClaimLog({
      logs: claimVerdict.logs,
      emitter,
      expected: {
        treasuryIdentity: observedClaimEvent.treasuryIdentity,
        payoutReceiver: observedClaimEvent.payoutReceiver,
        amountRaw: observedClaimEvent.claimAmount,
        triggeredBy: observedClaimEvent.triggeredBy,
      },
    });
    if (!claimLog.matched) {
      throw new Error(`TreasuryClaimed transaction does not prove this claim: ${claimLog.detail}`);
    }

    return recordSweepBatchExecution({
      claim: {
        sourceEventId: observedClaimEvent.id,
        matchedSweepBatchId: params.batchId,
        txHash: observedClaimEvent.txHash,
        blockNumber: observedClaimEvent.blockNumber,
        observedAt: observedClaimEvent.timestamp,
        treasuryIdentity: observedClaimEvent.treasuryIdentity,
        payoutReceiver: observedClaimEvent.payoutReceiver,
        amountRaw: observedClaimEvent.claimAmount,
        triggeredBy: observedClaimEvent.triggeredBy ?? claimLog.claim.triggeredBy,
      },
      actor: params.actor,
      metadata: params.metadata,
    });
  }
}
