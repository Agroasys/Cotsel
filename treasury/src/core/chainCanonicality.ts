/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / FAIL-06. Decides whether a stored ledger entry still corresponds
 * to an event the canonical chain contains.
 *
 * Eligibility used to be a comparison of block heights against the finalized
 * head. A height survives a reorganization unchanged, so that comparison can
 * never detect one: an entry read from an orphaned block reports the same
 * number afterwards and stays eligible forever. Identity is what distinguishes
 * the two chains, so every check here is anchored on the block hash and the
 * exact log position, and the verdict is re-derived from the settlement RPC
 * rather than read back from the row that is being questioned.
 */
export type ChainCanonicalityState = 'UNVERIFIED' | 'CANONICAL' | 'ORPHANED';

export type ChainMismatchReason =
  | 'RECEIPT_MISSING'
  | 'RECEIPT_REVERTED'
  | 'BLOCK_HASH_MISMATCH'
  | 'BLOCK_NUMBER_MISMATCH'
  | 'LOG_IDENTITY_MISMATCH';

export const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export interface ChainLogIdentity {
  txHash: string;
  blockNumber: number;
  blockHash: string | null;
  logIndex: number | null;
}

export interface CanonicalVerdict {
  state: 'CANONICAL';
  blockHash: string;
  stableBlockNumber: number;
}

export interface OrphanedVerdict {
  state: 'ORPHANED';
  reason: ChainMismatchReason;
  detail: string;
  expectedBlockHash: string | null;
  observedBlockHash: string | null;
  observedBlockNumber: number | null;
  observedLogIndex: number | null;
  depth: number;
  stableBlockNumber: number;
}

/**
 * Not a verdict about the chain, a statement that no verdict could be reached.
 * It never marks an entry orphaned -- an unreachable RPC is not evidence of a
 * reorganization -- but it never clears one for payout either.
 */
export interface UnverifiedVerdict {
  state: 'UNVERIFIED';
  detail: string;
  stableBlockNumber: number | null;
}

export type ChainCanonicalityVerdict = CanonicalVerdict | OrphanedVerdict | UnverifiedVerdict;

export interface SettlementReceipt {
  blockNumber: number | bigint;
  blockHash: string | null;
  status?: number | null;
  logs?: ReadonlyArray<{ index: number }>;
}

export interface SettlementChainReader {
  getBlock(
    tag: 'latest' | 'safe' | 'finalized' | number,
  ): Promise<{ number: number | bigint; hash: string | null } | null>;
  getTransactionReceipt(txHash: string): Promise<SettlementReceipt | null>;
}

/**
 * Hashes are compared as strings, so a single spelling has to be enforced
 * before the comparison rather than inside it. A mixed-case hash from one
 * provider and a lowercase hash from another describe the same block and must
 * not read as a reorganization.
 */
export function normalizeBlockHash(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return BLOCK_HASH_PATTERN.test(normalized) ? normalized : null;
}

function toBlockNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ChainStableHead {
  finalizedBlockNumber: number;
  finalizedBlockHash: string | null;
}

export class ChainCanonicalityVerifier {
  private readonly provider: SettlementChainReader | null;
  private readonly blockHashCache = new Map<number, string | null>();

  /**
   * The provider is always injected. This module stays free of configuration so
   * that `normalizeBlockHash` and the verdict types can be imported by the
   * persistence layer without dragging a settlement runtime behind them.
   */
  constructor(deps: { provider: SettlementChainReader | null }) {
    this.provider = deps.provider;
  }

  /**
   * Clears the per-block hash memo. A verifier is reused across an export or an
   * ingestion run, where one consistent view of the chain is what makes the run
   * reconcilable; a long-lived one must be reset between runs so a later run
   * cannot decide on a head that has since moved.
   */
  resetCache(): void {
    this.blockHashCache.clear();
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * The finalized head is the stable block every verdict in a run is measured
   * against, and the upper bound ingestion accepts evidence below. A provider
   * that cannot report one leaves the run without an anchor, so it returns null
   * and the caller stops rather than falling back to the latest head.
   */
  async resolveStableHead(): Promise<ChainStableHead | null> {
    if (!this.provider) {
      return null;
    }

    const finalized = await this.provider.getBlock('finalized');
    if (!finalized) {
      return null;
    }

    return {
      finalizedBlockNumber: toBlockNumber(finalized.number),
      finalizedBlockHash: normalizeBlockHash(finalized.hash),
    };
  }

  /**
   * The canonical hash at a height, memoized because one ingested block
   * commonly carries several fee components and each becomes its own entry.
   */
  async resolveBlockHash(blockNumber: number): Promise<string | null> {
    const cached = this.blockHashCache.get(blockNumber);
    if (cached !== undefined) {
      return cached;
    }

    if (!this.provider) {
      return null;
    }

    const block = await this.provider.getBlock(blockNumber);
    const hash = block ? normalizeBlockHash(block.hash) : null;
    this.blockHashCache.set(blockNumber, hash);
    return hash;
  }

  /**
   * Re-derives the verdict for one stored entry from the transaction receipt.
   *
   * The receipt is the authority rather than a second block lookup by height:
   * asking for block N returns whatever now occupies that height, which after a
   * reorganization is a different block that answers happily. The receipt
   * answers the question that actually matters -- where does this transaction
   * live on the canonical chain right now, and is it still successful -- and a
   * transaction dropped by the reorganization has no receipt at all.
   */
  async verify(
    entry: ChainLogIdentity,
    stableBlockNumber: number,
  ): Promise<ChainCanonicalityVerdict> {
    if (!this.provider) {
      return {
        state: 'UNVERIFIED',
        detail: 'Settlement runtime is not configured for chain canonicality checks',
        stableBlockNumber: null,
      };
    }

    const expectedBlockHash = normalizeBlockHash(entry.blockHash);
    if (!expectedBlockHash || entry.logIndex === null) {
      return {
        state: 'UNVERIFIED',
        detail:
          'Entry was ingested without a block hash and log index, so its chain identity cannot be re-derived',
        stableBlockNumber,
      };
    }

    let receipt: SettlementReceipt | null;
    try {
      receipt = await this.provider.getTransactionReceipt(entry.txHash);
    } catch (error) {
      return {
        state: 'UNVERIFIED',
        detail: `Settlement RPC did not answer the receipt lookup: ${describeError(error)}`,
        stableBlockNumber,
      };
    }

    const depth = Math.max(0, stableBlockNumber - entry.blockNumber);
    const orphaned = (
      reason: ChainMismatchReason,
      detail: string,
      observed: {
        blockHash?: string | null;
        blockNumber?: number | null;
        logIndex?: number | null;
      } = {},
    ): OrphanedVerdict => ({
      state: 'ORPHANED',
      reason,
      detail,
      expectedBlockHash,
      observedBlockHash: observed.blockHash ?? null,
      observedBlockNumber: observed.blockNumber ?? null,
      observedLogIndex: observed.logIndex ?? null,
      depth,
      stableBlockNumber,
    });

    if (!receipt) {
      return orphaned(
        'RECEIPT_MISSING',
        `Transaction ${entry.txHash} has no receipt on the canonical chain at stable block ${stableBlockNumber}`,
      );
    }

    const observedBlockNumber = toBlockNumber(receipt.blockNumber);
    const observedBlockHash = normalizeBlockHash(receipt.blockHash);

    if (receipt.status !== undefined && receipt.status !== null && receipt.status !== 1) {
      return orphaned(
        'RECEIPT_REVERTED',
        `Transaction ${entry.txHash} is no longer a successful receipt (status ${receipt.status})`,
        { blockHash: observedBlockHash, blockNumber: observedBlockNumber },
      );
    }

    if (observedBlockNumber !== entry.blockNumber) {
      return orphaned(
        'BLOCK_NUMBER_MISMATCH',
        `Transaction ${entry.txHash} was re-mined at block ${observedBlockNumber}, not the ingested block ${entry.blockNumber}`,
        { blockHash: observedBlockHash, blockNumber: observedBlockNumber },
      );
    }

    if (observedBlockHash !== expectedBlockHash) {
      return orphaned(
        'BLOCK_HASH_MISMATCH',
        `Block ${entry.blockNumber} is now ${observedBlockHash ?? 'unknown'} on the canonical chain, not the ingested ${expectedBlockHash}`,
        { blockHash: observedBlockHash, blockNumber: observedBlockNumber },
      );
    }

    // The block matches, so the remaining question is whether this entry still
    // points at the same log inside it. A receipt that no longer carries the
    // ingested log index is a different transaction shape than the one the
    // amount was read from.
    if (receipt.logs && !receipt.logs.some((log) => log.index === entry.logIndex)) {
      return orphaned(
        'LOG_IDENTITY_MISMATCH',
        `Receipt for ${entry.txHash} no longer contains log index ${entry.logIndex}`,
        {
          blockHash: observedBlockHash,
          blockNumber: observedBlockNumber,
          logIndex: receipt.logs.length > 0 ? receipt.logs[0].index : null,
        },
      );
    }

    return {
      state: 'CANONICAL',
      blockHash: expectedBlockHash,
      stableBlockNumber,
    };
  }
}

/** Row shape of the append-only `treasury_chain_reorg_events` evidence table. */
export interface LedgerChainReorgEvent {
  id: number;
  ledger_entry_id: number;
  entry_key: string;
  trade_id: string;
  tx_hash: string;
  block_number: number;
  expected_block_hash: string | null;
  observed_block_hash: string | null;
  observed_block_number: number | null;
  observed_log_index: number | null;
  reorg_depth: number | null;
  stable_block_number: number;
  mismatch_reason: ChainMismatchReason;
  detail: string | null;
  detected_at: Date;
  metadata: Record<string, unknown>;
}

export interface ChainCanonicalityCounts {
  canonical: number;
  orphaned: number;
  unverified: number;
}
