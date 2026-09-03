/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool, PoolClient } from 'pg';

export const GASLESS_TRANSACTION_OUTCOME_STATUSES = [
  'broadcast_pending',
  'broadcast_unknown',
  'confirmation_pending',
  'confirmed',
  'reverted',
  'replaced',
  'failed',
] as const;

export type GaslessTransactionOutcomeStatus = (typeof GASLESS_TRANSACTION_OUTCOME_STATUSES)[number];

export interface GaslessTransactionIdentity {
  transactionHash: string;
  applicationRequestId: string;
  resourceType: 'settlement_handoff' | 'platform_transfer';
  resourceId: string;
  operation: string;
  chainId: number;
  signerAddress: string;
  nonce: number;
  transactionType: number;
  destinationAddress: string;
  valueWei: string;
  gasLimit: string;
  maxFeePerGasWei?: string | null;
  maxPriorityFeePerGasWei?: string | null;
  gasPriceWei?: string | null;
  calldataHash: string;
  intentHash: string;
}

export interface GaslessTransactionOutcomeRecord extends GaslessTransactionIdentity {
  observedTransactionHash: string | null;
  outcomeStatus: GaslessTransactionOutcomeStatus;
  projectedOutcomeStatus: GaslessTransactionOutcomeStatus | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface GaslessConfirmedOutcome {
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
}

export interface GaslessTransactionOutcomeRecorder {
  recordPrepared(identity: GaslessTransactionIdentity): Promise<void>;
  markBroadcastUnknown(
    transactionHash: string,
    failureCode: string,
    observedTransactionHash?: string,
  ): Promise<void>;
  markConfirmationPending(transactionHash: string): Promise<void>;
  markConfirmed(transactionHash: string, outcome: GaslessConfirmedOutcome): Promise<void>;
  markReverted(transactionHash: string, outcome: GaslessConfirmedOutcome): Promise<void>;
}

export interface GaslessTransactionOutcomeStore extends GaslessTransactionOutcomeRecorder {
  listRecoveryCandidates(limit: number): Promise<GaslessTransactionOutcomeRecord[]>;
  markRecoveryAttempted(transactionHash: string): Promise<void>;
  markProjectionApplied(
    transactionHash: string,
    status: GaslessTransactionOutcomeStatus,
  ): Promise<void>;
}

function normalizeFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '').trim();
    if (code) return code.slice(0, 128);
  }
  return error instanceof Error ? error.name.slice(0, 128) : 'UNKNOWN_BROADCAST_ERROR';
}

export function gaslessBroadcastFailureCode(error: unknown): string {
  return normalizeFailureCode(error);
}

export function createPostgresGaslessTransactionOutcomeRecorder(
  pool: Pool,
): GaslessTransactionOutcomeStore {
  function allowedCurrentStatuses(status: GaslessTransactionOutcomeStatus): string[] {
    if (status === 'broadcast_unknown') {
      return ['broadcast_pending', 'broadcast_unknown', 'confirmation_pending'];
    }
    if (status === 'confirmation_pending') {
      return ['broadcast_pending', 'broadcast_unknown', 'confirmation_pending'];
    }
    if (status === 'confirmed' || status === 'reverted') {
      return ['broadcast_pending', 'broadcast_unknown', 'confirmation_pending'];
    }
    return [];
  }

  async function transition(
    transactionHash: string,
    status: GaslessTransactionOutcomeStatus,
    details: Partial<GaslessConfirmedOutcome> & {
      failureCode?: string;
      observedTransactionHash?: string;
    } = {},
  ): Promise<void> {
    const result = await pool.query(
      `WITH updated AS (
         UPDATE gasless_transaction_outcomes
         SET outcome_status = $2::varchar,
             failure_code = CASE
               WHEN $2::varchar = 'broadcast_unknown' THEN $3
               ELSE failure_code
             END,
             block_number = COALESCE($4, block_number),
             block_hash = COALESCE($5, block_hash),
             gas_used = COALESCE($6, gas_used),
             effective_gas_price_wei = COALESCE($7, effective_gas_price_wei),
             observed_transaction_hash = COALESCE($8, observed_transaction_hash),
             updated_at = NOW()
         WHERE transaction_hash = $1
           AND outcome_status = ANY($9::varchar[])
           AND (
             outcome_status IS DISTINCT FROM $2::varchar
             OR (
               $2::varchar = 'broadcast_unknown'
               AND (
                 failure_code IS DISTINCT FROM $3
                 OR observed_transaction_hash IS DISTINCT FROM
                    COALESCE($8, observed_transaction_hash)
               )
             )
           )
         RETURNING transaction_hash
       )
       INSERT INTO gasless_transaction_outcome_events (
         transaction_hash, outcome_status, failure_code, block_number, block_hash,
         observed_transaction_hash
       )
       SELECT transaction_hash, $2::varchar, $3, $4, $5, $8 FROM updated
       RETURNING transaction_hash`,
      [
        transactionHash,
        status,
        details.failureCode ?? null,
        details.blockNumber ?? null,
        details.blockHash ?? null,
        details.gasUsed ?? null,
        details.effectiveGasPriceWei ?? null,
        details.observedTransactionHash ?? null,
        allowedCurrentStatuses(status),
      ],
    );
    if (result.rowCount !== 1) {
      const current = await pool.query<{
        outcomeStatus: GaslessTransactionOutcomeStatus;
        failureCode: string | null;
        blockNumber: string | null;
        blockHash: string | null;
        gasUsed: string | null;
        effectiveGasPriceWei: string | null;
        observedTransactionHash: string | null;
      }>(
        `SELECT
           outcome_status AS "outcomeStatus",
           failure_code AS "failureCode",
           block_number AS "blockNumber",
           block_hash AS "blockHash",
           gas_used AS "gasUsed",
           effective_gas_price_wei AS "effectiveGasPriceWei",
           observed_transaction_hash AS "observedTransactionHash"
         FROM gasless_transaction_outcomes
         WHERE transaction_hash = $1`,
        [transactionHash],
      );
      const existing = current.rows[0];
      const sameFailureCode =
        status !== 'broadcast_unknown' || existing?.failureCode === (details.failureCode ?? null);
      const sameObservedTransactionHash =
        status !== 'broadcast_unknown' ||
        details.observedTransactionHash === undefined ||
        (existing?.observedTransactionHash ?? null) === (details.observedTransactionHash ?? null);
      const sameTerminalOutcome =
        (status !== 'confirmed' && status !== 'reverted') ||
        (existing?.blockNumber === (details.blockNumber ?? null) &&
          existing?.blockHash === (details.blockHash ?? null) &&
          existing?.gasUsed === (details.gasUsed ?? null) &&
          existing?.effectiveGasPriceWei === (details.effectiveGasPriceWei ?? null));
      if (
        existing?.outcomeStatus === status &&
        sameFailureCode &&
        sameObservedTransactionHash &&
        sameTerminalOutcome
      ) {
        return;
      }
      throw new Error(`Invalid gasless transaction outcome transition for ${transactionHash}`);
    }
  }

  async function recordTerminal(
    transactionHash: string,
    status: 'confirmed' | 'reverted',
    outcome: GaslessConfirmedOutcome,
  ): Promise<void> {
    await transition(transactionHash, status, outcome);
  }

  return {
    async listRecoveryCandidates(limit) {
      const result = await pool.query<{
        transactionHash: string;
        applicationRequestId: string;
        resourceType: GaslessTransactionIdentity['resourceType'];
        resourceId: string;
        operation: string;
        chainId: string;
        signerAddress: string;
        nonce: string;
        transactionType: number;
        destinationAddress: string;
        valueWei: string;
        gasLimit: string;
        maxFeePerGasWei: string | null;
        maxPriorityFeePerGasWei: string | null;
        gasPriceWei: string | null;
        calldataHash: string;
        intentHash: string;
        observedTransactionHash: string | null;
        outcomeStatus: GaslessTransactionOutcomeStatus;
        projectedOutcomeStatus: GaslessTransactionOutcomeStatus | null;
        failureCode: string | null;
        updatedAt: Date;
      }>(
        `SELECT
           transaction_hash AS "transactionHash",
           application_request_id AS "applicationRequestId",
           resource_type AS "resourceType",
           resource_id AS "resourceId",
           operation,
           chain_id AS "chainId",
           signer_address AS "signerAddress",
           transaction_nonce AS nonce,
           transaction_type AS "transactionType",
           destination_address AS "destinationAddress",
           value_wei AS "valueWei",
           gas_limit AS "gasLimit",
           max_fee_per_gas_wei AS "maxFeePerGasWei",
           max_priority_fee_per_gas_wei AS "maxPriorityFeePerGasWei",
           gas_price_wei AS "gasPriceWei",
           calldata_hash AS "calldataHash",
           intent_hash AS "intentHash",
           observed_transaction_hash AS "observedTransactionHash",
           outcome_status AS "outcomeStatus",
           projected_outcome_status AS "projectedOutcomeStatus",
           failure_code AS "failureCode",
           updated_at AS "updatedAt"
         FROM gasless_transaction_outcomes
         WHERE outcome_status IN (
             'broadcast_pending', 'broadcast_unknown', 'confirmation_pending'
           )
            OR projected_outcome_status IS DISTINCT FROM outcome_status
         ORDER BY COALESCE(last_reconciliation_attempt_at, created_at) ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        ...row,
        chainId: Number(row.chainId),
        nonce: Number(row.nonce),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    async markRecoveryAttempted(transactionHash) {
      await pool.query(
        `UPDATE gasless_transaction_outcomes
         SET last_reconciliation_attempt_at = NOW()
         WHERE transaction_hash = $1
           AND outcome_status IN (
             'broadcast_pending', 'broadcast_unknown', 'confirmation_pending'
           )`,
        [transactionHash],
      );
    },
    async markProjectionApplied(transactionHash, status) {
      const result = await pool.query(
        `UPDATE gasless_transaction_outcomes
         SET projected_outcome_status = $2, updated_at = NOW()
         WHERE transaction_hash = $1
           AND outcome_status = $2`,
        [transactionHash, status],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Gasless outcome changed before projection for ${transactionHash}`);
      }
    },
    async recordPrepared(identity) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `INSERT INTO gasless_transaction_outcomes (
           transaction_hash, application_request_id, resource_type, resource_id,
           operation, chain_id, signer_address, transaction_nonce, transaction_type,
           destination_address, value_wei, gas_limit, max_fee_per_gas_wei,
           max_priority_fee_per_gas_wei, gas_price_wei, calldata_hash, intent_hash,
           outcome_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           $16, $17, 'broadcast_pending'
         )
         ON CONFLICT (transaction_hash) DO NOTHING
         RETURNING transaction_hash`,
          [
            identity.transactionHash,
            identity.applicationRequestId,
            identity.resourceType,
            identity.resourceId,
            identity.operation,
            identity.chainId,
            identity.signerAddress,
            identity.nonce,
            identity.transactionType,
            identity.destinationAddress,
            identity.valueWei,
            identity.gasLimit,
            identity.maxFeePerGasWei ?? null,
            identity.maxPriorityFeePerGasWei ?? null,
            identity.gasPriceWei ?? null,
            identity.calldataHash,
            identity.intentHash,
          ],
        );
        if (result.rowCount !== 1) {
          throw new Error(
            `Gasless transaction identity already exists for ${identity.transactionHash}`,
          );
        }
        await client.query(
          `INSERT INTO gasless_transaction_outcome_events (transaction_hash, outcome_status)
           VALUES ($1, 'broadcast_pending')`,
          [identity.transactionHash],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async markBroadcastUnknown(transactionHash, failureCode, observedTransactionHash) {
      await transition(transactionHash, 'broadcast_unknown', {
        failureCode,
        observedTransactionHash,
      });
    },
    async markConfirmationPending(transactionHash) {
      await transition(transactionHash, 'confirmation_pending');
    },
    async markConfirmed(transactionHash, outcome) {
      await recordTerminal(transactionHash, 'confirmed', outcome);
    },
    async markReverted(transactionHash, outcome) {
      await recordTerminal(transactionHash, 'reverted', outcome);
    },
  };
}
