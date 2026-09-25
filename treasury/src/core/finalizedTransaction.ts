/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08. Whether a transaction reported by the indexer is a successful
 * receipt at the reported height on the canonical chain, at or below the
 * finalized head.
 *
 * This is for evidence that carries no stored log identity to re-derive -- the
 * TreasuryClaimed transaction a sweep batch is matched against. The verdict
 * hands back the receipt's logs so the caller can decode the event it expects
 * from them (`treasuryClaimLog.ts`). Ledger entries, which do carry a stored
 * identity, go through `ChainCanonicalityVerifier` instead.
 */
import type { SettlementChainReader, SettlementLog } from './chainCanonicality';

export type FinalizedTransactionVerdict =
  | {
      finalized: true;
      finalizedBlockNumber: number;
      logs: ReadonlyArray<SettlementLog> | null;
    }
  | { finalized: false; detail: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FinalizedTransactionVerifier {
  private readonly provider: SettlementChainReader | null;

  constructor(deps: { provider: SettlementChainReader | null }) {
    this.provider = deps.provider;
  }

  async verify(txHash: string, blockNumber: number): Promise<FinalizedTransactionVerdict> {
    if (!this.provider) {
      return {
        finalized: false,
        detail: 'Settlement runtime is not configured for chain canonicality checks',
      };
    }

    let finalizedBlockNumber: number | null;
    let receipt: Awaited<ReturnType<SettlementChainReader['getTransactionReceipt']>>;
    try {
      const head = await this.provider.getBlock('finalized');
      finalizedBlockNumber = head ? Number(head.number) : null;
      receipt =
        finalizedBlockNumber === null ? null : await this.provider.getTransactionReceipt(txHash);
    } catch (error) {
      return { finalized: false, detail: `Settlement RPC did not answer: ${describeError(error)}` };
    }

    if (finalizedBlockNumber === null) {
      return { finalized: false, detail: 'Settlement RPC reported no finalized head' };
    }

    if (blockNumber > finalizedBlockNumber) {
      return {
        finalized: false,
        detail: `Block ${blockNumber} is above the finalized head ${finalizedBlockNumber}`,
      };
    }

    if (!receipt) {
      return {
        finalized: false,
        detail: `Transaction ${txHash} has no receipt on the canonical chain`,
      };
    }

    if (receipt.status !== undefined && receipt.status !== null && receipt.status !== 1) {
      return {
        finalized: false,
        detail: `Transaction ${txHash} is not a successful receipt (status ${receipt.status})`,
      };
    }

    const observedBlockNumber = Number(receipt.blockNumber);
    if (observedBlockNumber !== blockNumber) {
      return {
        finalized: false,
        detail: `Transaction ${txHash} is at block ${observedBlockNumber} on the canonical chain, not the reported ${blockNumber}`,
      };
    }

    return { finalized: true, finalizedBlockNumber, logs: receipt.logs ?? null };
  }
}
