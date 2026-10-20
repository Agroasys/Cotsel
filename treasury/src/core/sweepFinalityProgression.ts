import {
  assertFreshTreasuryFinalizedEvidence,
  type TreasuryFinalizedEvidence,
} from './finalizedTransaction';
import type { SweepBatch } from '../types';
/** Revalidate the original sweep, separately from the fee accrual that funded it. */
export function assertSweepFinalityForProgression(
  batch: SweepBatch,
  evidence: TreasuryFinalizedEvidence | undefined,
): void {
  const original = batch.metadata.settlementFinalizedEvidence as
    TreasuryFinalizedEvidence | undefined;
  if (!evidence || !original || !batch.matched_sweep_tx_hash || !batch.matched_sweep_block_number)
    throw new Error('Original finalized sweep evidence is required for financial progression');
  assertFreshTreasuryFinalizedEvidence(
    evidence,
    batch.matched_sweep_tx_hash,
    batch.matched_sweep_block_number,
  );
  if (
    original.policyVersion !== evidence.policyVersion ||
    original.chainId !== evidence.chainId ||
    original.transactionHash !== evidence.transactionHash ||
    original.blockHash !== evidence.blockHash ||
    original.blockNumber !== evidence.blockNumber
  )
    throw new Error('Original sweep evidence changed; financial progression is blocked');
}
