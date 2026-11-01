import type { PoisonLogReason, QuarantinedLogEntry } from './quarantine';

/**
 * Thrown after a poison log has been durably quarantined. It must propagate
 * out of the batch handler: Subsquid then rolls back the batch transaction,
 * which includes the `squid_processor.status` update, so the checkpoint stays
 * behind the block we failed to project.
 */
export class PoisonLogHaltError extends Error {
  readonly entry: QuarantinedLogEntry;

  constructor(entry: QuarantinedLogEntry) {
    super(
      `Indexer halted on ${entry.reason} escrow log at block ${entry.blockNumber} (tx ${entry.txHash}, log index ${entry.logIndex}): ${entry.errorMessage}`,
    );
    this.name = 'PoisonLogHaltError';
    this.entry = entry;
  }
}

export interface RawEscrowLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionIndex: number;
}

export interface PoisonLogInput {
  reason: PoisonLogReason;
  error: unknown;
  eventName?: string | null;
  abiFingerprint: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  log: RawEscrowLog;
}

export interface PoisonLogDeps {
  quarantine: { recordPoisonLog(entry: QuarantinedLogEntry): Promise<void> };
  alerts: { poisonLogDetected(entry: QuarantinedLogEntry): Promise<void> };
  logger: { error(message: string, meta?: Record<string, unknown>): void };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Capture the complete raw log, so the evidence survives an ABI correction. */
export function buildQuarantinedLogEntry(input: PoisonLogInput): QuarantinedLogEntry {
  return {
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    logIndex: input.log.logIndex,
    transactionIndex: input.log.transactionIndex,
    contractAddress: input.log.address.toLowerCase(),
    topics: [...input.log.topics],
    data: input.log.data,
    reason: input.reason,
    errorMessage: describeError(input.error),
    abiFingerprint: input.abiFingerprint,
    eventName: input.eventName ?? null,
  };
}

/** Attempt independent evidence and alert writes without replacing the batch failure. */
export async function reportPoisonLog(
  deps: PoisonLogDeps,
  input: PoisonLogInput,
): Promise<QuarantinedLogEntry> {
  const entry = buildQuarantinedLogEntry(input);

  deps.logger.error('Quarantining unprojectable escrow log and holding the checkpoint', {
    reason: entry.reason,
    blockNumber: entry.blockNumber,
    txHash: entry.txHash,
    logIndex: entry.logIndex,
    eventName: entry.eventName,
    error: entry.errorMessage,
  });

  try {
    await deps.quarantine.recordPoisonLog(entry);
  } catch (error) {
    deps.logger.error('Failed to durably quarantine escrow log; halting anyway', {
      blockNumber: entry.blockNumber,
      txHash: entry.txHash,
      logIndex: entry.logIndex,
      error: describeError(error),
    });
  }

  try {
    await deps.alerts.poisonLogDetected(entry);
  } catch (error) {
    deps.logger.error('Failed to raise poison-log alert; halting anyway', {
      blockNumber: entry.blockNumber,
      error: describeError(error),
    });
  }

  return entry;
}

/** Evidence and alert failures never permit the processor checkpoint to advance. */
export async function haltOnPoisonLog(deps: PoisonLogDeps, input: PoisonLogInput): Promise<never> {
  throw new PoisonLogHaltError(await reportPoisonLog(deps, input));
}
