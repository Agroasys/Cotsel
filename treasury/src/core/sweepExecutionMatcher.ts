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
import {
  FinalizedTransactionVerifier,
  createTreasurySweepWitnesses,
  type TreasuryFinalizedEvidence,
} from './finalizedTransaction';
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
        witnesses: createTreasurySweepWitnesses(
          [config.rpcUrl, ...config.rpcFallbackUrls].filter((url): url is string => Boolean(url)),
        ),
        rail:
          config.chainId && config.escrowAddress && config.usdcAddress
            ? {
                chainId: config.chainId,
                escrowAddress: config.escrowAddress,
                usdcAddress: config.usdcAddress,
              }
            : null,
      });
  }

  async matchApprovedBatch(params: {
    batchId: number;
    txHash: string;
    actor: string;
    metadata?: Record<string, unknown>;
  }): Promise<SweepBatch> {
    return (await this.verifyAndMatch(params)).batch;
  }

  async revalidateMatchedBatch(batchId: number): Promise<TreasuryFinalizedEvidence> {
    const detail = await getSweepBatchDetail(batchId);
    if (
      !detail ||
      !['EXECUTED', 'HANDED_OFF', 'CLOSED'].includes(detail.batch.status) ||
      !detail.batch.matched_sweep_tx_hash
    )
      throw new Error('Original executed sweep evidence is required for progression');
    return (
      await this.verifyAndMatch({
        batchId,
        txHash: detail.batch.matched_sweep_tx_hash,
        actor: 'chain-revalidation',
      })
    ).evidence;
  }

  private async verifyAndMatch(params: {
    batchId: number;
    txHash: string;
    actor: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ batch: SweepBatch; evidence: TreasuryFinalizedEvidence }> {
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
      if (!['APPROVED', 'EXECUTED', 'HANDED_OFF', 'CLOSED'].includes(detail.batch.status))
        throw new Error('Previously matched sweep has an incompatible accounting state');
    }

    const previouslyExecuted =
      existingClaimEvent !== null &&
      existingClaimEvent !== undefined &&
      detail.batch.status !== 'APPROVED';
    const persistedClaimEvent =
      existingClaimEvent ?? (await getTreasuryClaimEventByTxHash(normalizedTxHash));
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
      verificationOnly: previouslyExecuted,
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
    if (emitter.toLowerCase() !== claimVerdict.escrowAddress)
      throw new Error(
        'Sweep batch entries differ from the independently verified settlement escrow',
      );
    const claimLog = verifyTreasuryClaimLog({
      logs: claimVerdict.logs,
      emitter,
      tokenAddress: claimVerdict.tokenAddress,
      treasuryIdentity: claimVerdict.treasuryIdentity,
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

    const recorded = detail.batch.metadata.settlementFinalizedEvidence as
      Record<string, unknown> | undefined;
    if (
      (previouslyExecuted && !recorded) ||
      (recorded &&
        (recorded.policyVersion !== 'treasury_dual_rpc_finalized_v1' ||
          recorded.blockHash !== claimVerdict.blockHash ||
          recorded.transactionHash !== normalizedTxHash ||
          recorded.chainId !== claimVerdict.finalizedEvidence.chainId))
    )
      throw new Error(
        'Original sweep finalized evidence requires governed reconciliation; it cannot be replaced',
      );
    if (previouslyExecuted)
      return { batch: detail.batch, evidence: claimVerdict.finalizedEvidence };

    const batch = await recordSweepBatchExecution({
      finalizedEvidence: claimVerdict.finalizedEvidence,
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
      metadata: {
        ...(params.metadata ?? {}),
        settlementFinalizedEvidence: recorded ?? claimVerdict.finalizedEvidence,
      },
    });
    return { batch, evidence: claimVerdict.finalizedEvidence };
  }
}
