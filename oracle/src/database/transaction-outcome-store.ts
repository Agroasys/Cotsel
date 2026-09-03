import type { Pool, PoolClient } from 'pg';

export type OracleTransactionOutcomeStatus =
  | 'broadcast_pending'
  | 'broadcast_unknown'
  | 'confirmation_pending'
  | 'reverted';

export interface OracleTransactionIdentity {
  transactionHash: string;
  triggerIdempotencyKey: string;
  chainId: number;
  signerAddress: string;
  nonce: number;
  transactionType: 0 | 2;
  destinationAddress: string;
  valueWei: string;
  gasLimit: string;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  gasPriceWei: string | null;
  calldataHash: string;
  intentHash: string;
}

export interface OracleTransactionOutcomeRecord extends OracleTransactionIdentity {
  outcomeStatus: OracleTransactionOutcomeStatus;
  failureCode: string | null;
  blockNumber: string | null;
}

export interface OracleTransactionOutcomeStore {
  recordPrepared(identity: OracleTransactionIdentity): Promise<void>;
  markBroadcastUnknown(transactionHash: string, failureCode: string): Promise<void>;
  markConfirmationPending(transactionHash: string, blockNumber?: number): Promise<void>;
  markReverted(transactionHash: string, blockNumber: number): Promise<void>;
  markRecoveryAttempted(transactionHash: string): Promise<void>;
  listRecoveryCandidates(limit: number): Promise<OracleTransactionOutcomeRecord[]>;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function mapRecord(row: Record<string, unknown>): OracleTransactionOutcomeRecord {
  return {
    transactionHash: String(row.transaction_hash),
    triggerIdempotencyKey: String(row.trigger_idempotency_key),
    chainId: Number(row.chain_id),
    signerAddress: String(row.signer_address),
    nonce: Number(row.transaction_nonce),
    transactionType: Number(row.transaction_type) as 0 | 2,
    destinationAddress: String(row.destination_address),
    valueWei: String(row.value_wei),
    gasLimit: String(row.gas_limit),
    maxFeePerGasWei: row.max_fee_per_gas_wei === null ? null : String(row.max_fee_per_gas_wei),
    maxPriorityFeePerGasWei:
      row.max_priority_fee_per_gas_wei === null ? null : String(row.max_priority_fee_per_gas_wei),
    gasPriceWei: row.gas_price_wei === null ? null : String(row.gas_price_wei),
    calldataHash: String(row.calldata_hash),
    intentHash: String(row.intent_hash),
    outcomeStatus: String(row.outcome_status) as OracleTransactionOutcomeStatus,
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    blockNumber: row.block_number === null ? null : String(row.block_number),
  };
}

function assertSameIdentity(
  existing: OracleTransactionOutcomeRecord,
  identity: OracleTransactionIdentity,
): void {
  const comparableExisting = {
    ...existing,
    outcomeStatus: undefined,
    failureCode: undefined,
    blockNumber: undefined,
  };
  const comparableIdentity = { ...identity } as Record<string, unknown>;
  delete (comparableExisting as Record<string, unknown>).outcomeStatus;
  delete (comparableExisting as Record<string, unknown>).failureCode;
  delete (comparableExisting as Record<string, unknown>).blockNumber;

  if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableIdentity)) {
    throw new Error('Oracle trigger already has a different durable transaction identity');
  }
}

export function createPostgresOracleTransactionOutcomeStore(
  pool: Pool,
): OracleTransactionOutcomeStore {
  return {
    async recordPrepared(identity) {
      await inTransaction(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO oracle_transaction_outcomes (
             transaction_hash, trigger_idempotency_key, chain_id, signer_address,
             transaction_nonce, transaction_type, destination_address, value_wei,
             gas_limit, max_fee_per_gas_wei, max_priority_fee_per_gas_wei,
             gas_price_wei, calldata_hash, intent_hash, outcome_status
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             'broadcast_pending'
           )
           ON CONFLICT DO NOTHING
           RETURNING transaction_hash`,
          [
            identity.transactionHash,
            identity.triggerIdempotencyKey,
            identity.chainId,
            identity.signerAddress,
            identity.nonce,
            identity.transactionType,
            identity.destinationAddress,
            identity.valueWei,
            identity.gasLimit,
            identity.maxFeePerGasWei,
            identity.maxPriorityFeePerGasWei,
            identity.gasPriceWei,
            identity.calldataHash,
            identity.intentHash,
          ],
        );

        if (inserted.rowCount === 0) {
          const existing = await client.query(
            `SELECT * FROM oracle_transaction_outcomes
             WHERE transaction_hash = $1 OR trigger_idempotency_key = $2`,
            [identity.transactionHash, identity.triggerIdempotencyKey],
          );
          if (!existing.rows[0]) {
            throw new Error('Oracle transaction identity conflict could not be resolved');
          }
          assertSameIdentity(mapRecord(existing.rows[0]), identity);
        }

        const trigger = await client.query(
          `UPDATE oracle_triggers
           SET status = 'BROADCAST_PENDING', tx_hash = $1, updated_at = NOW()
           WHERE idempotency_key = $2
             AND status IN ('EXECUTING', 'BROADCAST_PENDING')
           RETURNING idempotency_key`,
          [identity.transactionHash, identity.triggerIdempotencyKey],
        );
        if (trigger.rowCount !== 1) {
          throw new Error('Oracle trigger was not eligible for transaction identity persistence');
        }
      });
    },

    async markBroadcastUnknown(transactionHash, failureCode) {
      await inTransaction(pool, async (client) => {
        const outcome = await client.query(
          `UPDATE oracle_transaction_outcomes
           SET outcome_status = 'broadcast_unknown', failure_code = $2, updated_at = NOW()
           WHERE transaction_hash = $1
             AND outcome_status IN ('broadcast_pending', 'broadcast_unknown')
           RETURNING trigger_idempotency_key`,
          [transactionHash, failureCode],
        );
        if (!outcome.rows[0]) {
          throw new Error('Oracle transaction was not eligible for broadcast-unknown transition');
        }
        await client.query(
          `UPDATE oracle_triggers
           SET status = 'BROADCAST_UNKNOWN', last_error = $2, error_type = 'NETWORK', updated_at = NOW()
           WHERE idempotency_key = $1`,
          [outcome.rows[0].trigger_idempotency_key, failureCode],
        );
      });
    },

    async markConfirmationPending(transactionHash, blockNumber) {
      await inTransaction(pool, async (client) => {
        const outcome = await client.query(
          `UPDATE oracle_transaction_outcomes
           SET outcome_status = 'confirmation_pending', failure_code = NULL,
               block_number = COALESCE($2, block_number),
               broadcast_observed_at = COALESCE(broadcast_observed_at, NOW()),
               updated_at = NOW()
           WHERE transaction_hash = $1
             AND outcome_status IN ('broadcast_pending', 'broadcast_unknown', 'confirmation_pending')
           RETURNING trigger_idempotency_key, block_number`,
          [transactionHash, blockNumber ?? null],
        );
        if (!outcome.rows[0]) {
          throw new Error('Oracle transaction was not eligible for submitted transition');
        }
        await client.query(
          `UPDATE oracle_triggers
           SET status = 'SUBMITTED', block_number = COALESCE($2, block_number),
               submitted_at = COALESCE(submitted_at, NOW()), last_error = NULL,
               error_type = NULL, updated_at = NOW()
           WHERE idempotency_key = $1`,
          [outcome.rows[0].trigger_idempotency_key, outcome.rows[0].block_number],
        );
      });
    },

    async markReverted(transactionHash, blockNumber) {
      await inTransaction(pool, async (client) => {
        const outcome = await client.query(
          `UPDATE oracle_transaction_outcomes
           SET outcome_status = 'reverted', failure_code = 'TRANSACTION_REVERTED',
               block_number = $2, updated_at = NOW()
           WHERE transaction_hash = $1
           RETURNING trigger_idempotency_key`,
          [transactionHash, blockNumber],
        );
        if (!outcome.rows[0]) {
          throw new Error('Oracle transaction was not available for reverted transition');
        }
        await client.query(
          `UPDATE oracle_triggers
           SET status = 'TERMINAL_FAILURE', block_number = $2,
               last_error = 'TRANSACTION_REVERTED', error_type = 'CONTRACT', updated_at = NOW()
           WHERE idempotency_key = $1`,
          [outcome.rows[0].trigger_idempotency_key, blockNumber],
        );
      });
    },

    async markRecoveryAttempted(transactionHash) {
      await pool.query(
        `UPDATE oracle_transaction_outcomes
         SET recovery_attempted_at = NOW(), updated_at = NOW()
         WHERE transaction_hash = $1`,
        [transactionHash],
      );
    },

    async listRecoveryCandidates(limit) {
      const result = await pool.query(
        `SELECT * FROM oracle_transaction_outcomes
         WHERE outcome_status IN (
           'broadcast_pending', 'broadcast_unknown', 'confirmation_pending'
         )
         ORDER BY updated_at ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map(mapRecord);
    },
  };
}
