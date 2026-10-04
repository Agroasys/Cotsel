import { createServicePool, type PostgresSslMode } from '@agroasys/shared-db';
import type { Pool } from 'pg';

/**
 * Durable custody for chain logs the indexer could not project.
 *
 * This store deliberately does NOT write through the Subsquid `ctx.store`.
 * `TypeormDatabase.transact` runs the entity writes and the
 * `squid_processor.status` checkpoint update inside a single transaction, and
 * the poison-log response is to let that transaction roll back so the
 * checkpoint cannot advance past a log we failed to project. A quarantine row
 * written on the same connection would be rolled back with it, which is
 * exactly the silent-loss behaviour this exists to prevent. The row therefore
 * commits on an independent connection and outlives the rollback.
 */

export const QUARANTINE_TABLE = 'indexer_quarantined_log';

export type PoisonLogReason = 'UNDECODABLE' | 'UNKNOWN_EVENT' | 'HANDLER_FAILURE';

export interface QuarantinedLogEntry {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  transactionIndex: number;
  contractAddress: string;
  topics: string[];
  data: string;
  reason: PoisonLogReason;
  errorMessage: string;
  abiFingerprint: string;
  eventName: string | null;
}

export interface QuarantinedLogRow {
  blockNumber: string;
  txHash: string;
  logIndex: number;
  reason: string;
  errorMessage: string;
  eventName: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Minimal surface of a `pg` pool/client, so tests can supply a fake. */
export interface QuarantineQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface QuarantinePoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode?: PostgresSslMode;
}

/**
 * The independent connection described above. Kept tiny (`max: 3`) because it
 * is only used for preflight counts, readiness probes (quarantine count and
 * checkpoint read in parallel), and the rare poison-log write.
 */
export function createQuarantinePool(config: QuarantinePoolConfig): Pool {
  return createServicePool({
    serviceName: 'indexer',
    connectionRole: 'runtime',
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    sslMode: config.sslMode,
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });
}

const RECORD_POISON_LOG_SQL = `
  INSERT INTO ${QUARANTINE_TABLE} (
    block_number, block_hash, tx_hash, log_index, transaction_index, contract_address,
    topics, data, reason, error_message, abi_fingerprint, event_name,
    status, first_seen_at, last_seen_at, occurrences
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12,
    'UNRESOLVED', now(), now(), 1
  )
  ON CONFLICT (block_number, tx_hash, log_index) DO UPDATE SET
    reason = EXCLUDED.reason,
    error_message = EXCLUDED.error_message,
    abi_fingerprint = EXCLUDED.abi_fingerprint,
    event_name = EXCLUDED.event_name,
    last_seen_at = now(),
    occurrences = ${QUARANTINE_TABLE}.occurrences + 1,
    status = 'UNRESOLVED',
    resolved_at = NULL,
    resolution_note = NULL`;

const COUNT_UNRESOLVED_SQL = `
  SELECT COUNT(*)::int AS count FROM ${QUARANTINE_TABLE} WHERE status = 'UNRESOLVED'`;

const LIST_UNRESOLVED_SQL = `
  SELECT block_number::text AS block_number, tx_hash, log_index, reason, error_message,
         event_name, occurrences, first_seen_at::text AS first_seen_at,
         last_seen_at::text AS last_seen_at
  FROM ${QUARANTINE_TABLE}
  WHERE status = 'UNRESOLVED'
  ORDER BY block_number, log_index
  LIMIT $1`;

const RESOLVE_SQL = `
  UPDATE ${QUARANTINE_TABLE}
  SET status = 'RESOLVED', resolved_at = now(), resolution_note = $4
  WHERE block_number = $1 AND tx_hash = $2 AND log_index = $3 AND status = 'UNRESOLVED'`;

export class QuarantineStore {
  constructor(private readonly executor: QuarantineQueryExecutor) {}

  /**
   * Idempotent by (block, tx, log index): the fail-closed restart loop and any
   * later replay of the same block re-touch one row rather than accumulating
   * duplicates. A recurrence after an operator resolution reopens the row,
   * because a corrected cause would have decoded instead of landing here.
   */
  async recordPoisonLog(entry: QuarantinedLogEntry): Promise<void> {
    await this.executor.query(RECORD_POISON_LOG_SQL, [
      entry.blockNumber,
      entry.blockHash,
      entry.txHash,
      entry.logIndex,
      entry.transactionIndex,
      entry.contractAddress,
      entry.topics,
      entry.data,
      entry.reason,
      entry.errorMessage,
      entry.abiFingerprint,
      entry.eventName,
    ]);
  }

  async countUnresolved(): Promise<number> {
    const result = await this.executor.query(COUNT_UNRESOLVED_SQL);
    const count = result.rows[0]?.count;
    return typeof count === 'number' ? count : Number(count ?? 0);
  }

  async listUnresolved(limit = 100): Promise<QuarantinedLogRow[]> {
    const result = await this.executor.query(LIST_UNRESOLVED_SQL, [limit]);
    return result.rows.map((row) => ({
      blockNumber: String(row.block_number),
      txHash: String(row.tx_hash),
      logIndex: Number(row.log_index),
      reason: String(row.reason),
      errorMessage: String(row.error_message),
      eventName: row.event_name === null ? null : String(row.event_name),
      occurrences: Number(row.occurrences),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  async resolve(input: {
    blockNumber: number;
    txHash: string;
    logIndex: number;
    note: string;
  }): Promise<void> {
    await this.executor.query(RESOLVE_SQL, [
      input.blockNumber,
      input.txHash,
      input.logIndex,
      input.note,
    ]);
  }
}
