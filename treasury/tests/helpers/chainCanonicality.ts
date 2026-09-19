/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Stubs for the WP-4 B-08 chain-canonicality dependencies, so a test about
 * reconciliation, export shape or route wiring does not have to model a whole
 * settlement chain just to get past the canonicality gate. Tests that are
 * about canonicality itself use the real verifier over `stubChainReader`.
 */
import { ChainCanonicalityVerifier } from '../../src/core/chainCanonicality';
import type { ChainLogIdentity, SettlementChainReader } from '../../src/core/chainCanonicality';

export const TEST_BLOCK_HASH = `0x${'ab'.repeat(32)}`;
export const TEST_REORGED_BLOCK_HASH = `0x${'cd'.repeat(32)}`;

export interface StubReceipt {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  status?: number;
}

/**
 * A settlement chain that answers from a fixed receipt table. A transaction
 * absent from the table has no receipt, which is how a reorganization that
 * dropped the transaction is expressed.
 */
export function stubChainReader(options: {
  receipts: StubReceipt[];
  finalizedBlockNumber?: number;
  blockHashes?: Record<number, string>;
}): SettlementChainReader {
  const finalized = options.finalizedBlockNumber ?? 500;
  const byTxHash = new Map(options.receipts.map((receipt) => [receipt.txHash, receipt]));

  return {
    async getBlock(tag) {
      if (tag === 'finalized' || tag === 'safe' || tag === 'latest') {
        return { number: finalized, hash: TEST_BLOCK_HASH };
      }
      const hash = options.blockHashes?.[tag] ?? TEST_BLOCK_HASH;
      return { number: tag, hash };
    },
    async getTransactionReceipt(txHash) {
      const receipt = byTxHash.get(txHash);
      if (!receipt) {
        return null;
      }
      return {
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: receipt.status ?? 1,
        logs: [{ index: receipt.logIndex }],
      };
    },
  };
}

export function stubVerifier(options: Parameters<typeof stubChainReader>[0]) {
  return new ChainCanonicalityVerifier({ provider: stubChainReader(options) });
}

/**
 * Agrees with whatever it is asked about. For tests whose subject is something
 * else, so that a canonicality failure cannot silently become the reason they
 * pass or fail.
 */
export function alwaysCanonicalVerifier(): ChainCanonicalityVerifier {
  return {
    resetCache() {},
    isConfigured: () => true,
    async resolveStableHead() {
      return { finalizedBlockNumber: 500, finalizedBlockHash: TEST_BLOCK_HASH };
    },
    async resolveBlockHash() {
      return TEST_BLOCK_HASH;
    },
    async verify(entry: ChainLogIdentity, stableBlockNumber: number) {
      return {
        state: 'CANONICAL' as const,
        blockHash: entry.blockHash ?? TEST_BLOCK_HASH,
        stableBlockNumber,
      };
    },
  } as unknown as ChainCanonicalityVerifier;
}

/** Records verdicts in memory instead of writing them to Postgres. */
export function recordingCanonicalityWriter() {
  const marked: Array<{ ledgerEntryId: number; blockHash: string }> = [];
  const orphaned: Array<Record<string, unknown>> = [];

  return {
    marked,
    orphaned,
    writer: {
      markCanonical: async (data: { ledgerEntryId: number; blockHash: string }) => {
        marked.push({ ledgerEntryId: data.ledgerEntryId, blockHash: data.blockHash });
      },
      recordOrphaned: async (data: Record<string, unknown>) => {
        orphaned.push(data);
        return { evidenceId: orphaned.length, payoutCancelled: data.cancelFromState !== null };
      },
    } as never,
  };
}
