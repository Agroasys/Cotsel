import { evaluateReadiness, type ReadinessResult } from '@agroasys/shared-edge';
import { callRpc } from './rpc-preflight';

/**
 * Startup gates and runtime readiness for the indexer pipeline.
 *
 * Startup gates refuse to run at all when the chain cannot support the
 * projection (no finality tag, or a stored checkpoint that is not on this
 * chain). Readiness reports, while running, whether the projection may be
 * trusted: the RPC still serves the configured chain, the checkpoint is within
 * the allowed lag of the finalized head, and no poison log is quarantined.
 */

export const PROCESSOR_STATUS_TABLE = 'squid_processor.status';

const DEFAULT_TIMEOUT_MS = 3000;
const EMPTY_HASH = '0x';

export class ChainReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainReadinessError';
  }
}

export interface ProcessorCheckpoint {
  height: number;
  hash: string;
}

/** Minimal surface of a `pg` pool/client, so tests can supply a fake. */
export interface CheckpointQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const READ_CHECKPOINT_SQL = `SELECT height, hash FROM ${PROCESSOR_STATUS_TABLE} WHERE id = 0`;

/** The finalized checkpoint Subsquid commits together with each batch, or null before the first batch. */
export async function readProcessorCheckpoint(
  executor: CheckpointQueryExecutor,
): Promise<ProcessorCheckpoint | null> {
  const result = await executor.query(READ_CHECKPOINT_SQL);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const height = Number(row.height);
  if (!Number.isSafeInteger(height)) {
    throw new ChainReadinessError('Processor checkpoint height is not an integer');
  }
  return { height, hash: typeof row.hash === 'string' ? row.hash : EMPTY_HASH };
}

function parseQuantity(value: unknown, method: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ChainReadinessError(`Invalid ${method} result`);
  }
  return BigInt(value);
}

interface BlockHeader {
  number: bigint;
  hash: string;
}

async function getBlockHeader(
  rpcUrl: string,
  tag: string,
  timeoutMs: number,
): Promise<BlockHeader | null> {
  const result = await callRpc(rpcUrl, 'eth_getBlockByNumber', [tag, false], timeoutMs);
  if (result === null) {
    return null;
  }
  if (!result || typeof result !== 'object') {
    throw new ChainReadinessError('Invalid eth_getBlockByNumber result');
  }

  const block = result as { number?: unknown; hash?: unknown };
  if (typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new ChainReadinessError('Invalid eth_getBlockByNumber result');
  }
  return { number: parseQuantity(block.number, 'eth_getBlockByNumber'), hash: block.hash };
}

async function getChainHead(rpcUrl: string, timeoutMs: number): Promise<bigint> {
  return parseQuantity(await callRpc(rpcUrl, 'eth_blockNumber', [], timeoutMs), 'eth_blockNumber');
}

/**
 * Reconciliation and treasury read the chain at the `finalized` tag. An endpoint
 * that cannot answer it would leave those consumers comparing against a weaker
 * state than the one this projection is reconciled to.
 */
export async function assertFinalitySupport(
  rpcUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ finalizedBlock: bigint; head: bigint }> {
  let finalized: BlockHeader | null;
  try {
    finalized = await getBlockHeader(rpcUrl, 'finalized', timeoutMs);
  } catch (error) {
    throw new ChainReadinessError(
      `RPC endpoint does not support the finalized block tag: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!finalized) {
    throw new ChainReadinessError('RPC endpoint returned no finalized block');
  }

  const head = await getChainHead(rpcUrl, timeoutMs);
  if (finalized.number > head) {
    throw new ChainReadinessError(
      `Finalized block ${finalized.number.toString()} is ahead of chain head ${head.toString()}`,
    );
  }
  return { finalizedBlock: finalized.number, head };
}

export interface CheckpointOnChainInput {
  rpcUrl: string;
  checkpoint: ProcessorCheckpoint | null;
  startBlock: number;
  timeoutMs?: number;
}

/**
 * A stored checkpoint must name a block this chain actually has. A database
 * restored from another chain, another deployment, or a reorganised fork would
 * otherwise resume past blocks it never projected.
 */
export async function assertCheckpointOnChain(
  input: CheckpointOnChainInput,
): Promise<'none' | 'verified'> {
  const { checkpoint } = input;
  if (!checkpoint || checkpoint.height < input.startBlock || checkpoint.hash === EMPTY_HASH) {
    return 'none';
  }

  const block = await getBlockHeader(
    input.rpcUrl,
    `0x${checkpoint.height.toString(16)}`,
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!block) {
    throw new ChainReadinessError(
      `Stored checkpoint ${checkpoint.height} is ahead of the chain; the database does not belong to this chain`,
    );
  }
  if (block.hash.toLowerCase() !== checkpoint.hash.toLowerCase()) {
    throw new ChainReadinessError(
      `Stored checkpoint ${checkpoint.height} hash does not match the chain; the database does not belong to this chain or fork`,
    );
  }
  return 'verified';
}

export interface IndexerReadinessDependencies {
  /** True once every startup gate has passed and the processor has been started. */
  startupComplete: () => boolean;
  /** The endpoint selected at startup; the processor reads only from it. */
  rpcUrl: () => string | null;
  chainId: number;
  readCheckpoint: () => Promise<ProcessorCheckpoint | null>;
  countUnresolvedQuarantine: () => Promise<number>;
  finalityConfirmationBlocks: number;
  maxCheckpointLagBlocks: number;
  rpcTimeoutMs?: number;
  timeoutMs?: number;
}

function requireRpcUrl(dependencies: IndexerReadinessDependencies): string {
  const url = dependencies.rpcUrl();
  if (!url) {
    throw new ChainReadinessError('No RPC endpoint selected');
  }
  return url;
}

/**
 * Lag is measured against the head minus the configured confirmations, which
 * is the newest block the processor is allowed to checkpoint. Anything further
 * behind than the allowance means consumers would read a stale projection.
 */
export function checkpointLagBlocks(
  head: bigint,
  checkpointHeight: number,
  finalityConfirmationBlocks: number,
): bigint {
  const newestCheckpointable = head - BigInt(finalityConfirmationBlocks);
  const lag = newestCheckpointable - BigInt(checkpointHeight);
  return lag > 0n ? lag : 0n;
}

export function createIndexerReadinessCheck(
  dependencies: IndexerReadinessDependencies,
): () => Promise<ReadinessResult> {
  const rpcTimeoutMs = dependencies.rpcTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return () =>
    evaluateReadiness(
      [
        {
          name: 'startup-preflight',
          check: async () => {
            if (!dependencies.startupComplete()) {
              throw new ChainReadinessError('Startup gates have not passed');
            }
          },
        },
        {
          name: 'chain-rpc',
          check: async () => {
            const url = requireRpcUrl(dependencies);
            const chainId = parseQuantity(
              await callRpc(url, 'eth_chainId', [], rpcTimeoutMs),
              'eth_chainId',
            );
            if (chainId !== BigInt(dependencies.chainId)) {
              throw new ChainReadinessError('RPC endpoint is on the wrong chain');
            }
          },
        },
        {
          name: 'quarantine',
          check: async () => {
            if ((await dependencies.countUnresolvedQuarantine()) > 0) {
              throw new ChainReadinessError('Unresolved quarantined escrow logs');
            }
          },
        },
        {
          name: 'checkpoint-freshness',
          check: async () => {
            const [checkpoint, head] = await Promise.all([
              dependencies.readCheckpoint(),
              getChainHead(requireRpcUrl(dependencies), rpcTimeoutMs),
            ]);
            if (!checkpoint) {
              throw new ChainReadinessError('No processor checkpoint yet');
            }
            const lag = checkpointLagBlocks(
              head,
              checkpoint.height,
              dependencies.finalityConfirmationBlocks,
            );
            if (lag > BigInt(dependencies.maxCheckpointLagBlocks)) {
              throw new ChainReadinessError('Processor checkpoint is stale');
            }
          },
        },
      ],
      { defaultTimeoutMs: dependencies.timeoutMs },
    );
}
