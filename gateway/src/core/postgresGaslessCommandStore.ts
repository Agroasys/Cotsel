/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type {
  GaslessCommandRecord,
  GaslessCommandStatus,
  GaslessCommandStore,
} from './gaslessCommandStore';
import { insertAuditLogWithClient } from './auditLogStore';
import {
  createGaslessCommandWithClient,
  GASLESS_COMMAND_COLUMNS,
  type GaslessCommandRow,
  mapGaslessCommand,
} from './postgresGaslessCommandQueries';

export { createGaslessCommandWithClient } from './postgresGaslessCommandQueries';

export function createPostgresGaslessCommandStore(pool: Pool): GaslessCommandStore {
  async function getByClause(clause: string, value: string): Promise<GaslessCommandRecord | null> {
    const result = await pool.query<GaslessCommandRow>(
      `SELECT ${GASLESS_COMMAND_COLUMNS} FROM gasless_commands WHERE ${clause} = $1`,
      [value],
    );
    return result.rows[0] ? mapGaslessCommand(result.rows[0]) : null;
  }

  async function finishAttempt(
    commandId: string,
    leaseOwner: string,
    completedAt: string,
    outcome: 'completed' | 'outcome_pending' | 'retry_scheduled' | 'dead_letter',
    updateSql: string,
    updateValues: unknown[],
    attempt: {
      transactionHash?: string | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    } = {},
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE gasless_commands
         SET ${updateSql}, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = $3::timestamptz
         WHERE command_id = $1 AND status = 'leased' AND lease_owner = $2
         RETURNING attempt_count`,
        [commandId, leaseOwner, completedAt, ...updateValues],
      );
      const attemptCount = updated.rows[0]?.attempt_count as number | undefined;
      if (attemptCount === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE gasless_command_attempts
         SET finished_at = $4, outcome = $5,
             transaction_hash = COALESCE($6, transaction_hash),
             error_code = COALESCE($7, error_code),
             error_detail = COALESCE($8, error_detail)
         WHERE command_id = $1 AND attempt_number = $2 AND lease_owner = $3`,
        [
          commandId,
          attemptCount,
          leaseOwner,
          completedAt,
          outcome,
          attempt.transactionHash ?? null,
          attempt.errorCode ?? null,
          attempt.errorDetail ?? null,
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async enqueueCommand(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const command = await createGaslessCommandWithClient(client, input);
        await client.query('COMMIT');
        return command;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    getCommand: (commandId) => getByClause('command_id', commandId),
    getByApplicationRequestId: (requestId) => getByClause('application_request_id', requestId),

    async claimDueCommand(leaseOwner, attemptedAt, leaseExpiresAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const exhausted = await client.query<{
          commandId: string;
          attemptCount: number;
          leaseOwner: string | null;
        }>(
          `WITH exhausted_candidate AS (
             SELECT command_id AS candidate_command_id,
                    attempt_count AS previous_attempt_count,
                    lease_owner AS previous_lease_owner
             FROM gasless_commands
             WHERE status = 'leased'
               AND lease_expires_at <= $1::timestamptz
               AND attempt_count >= max_attempts
             FOR UPDATE SKIP LOCKED
           ), exhausted AS (
             UPDATE gasless_commands AS command
             SET status = 'dead_letter',
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error_code = 'LEASE_ATTEMPTS_EXHAUSTED',
                 last_error_detail = 'Worker lease expired after the maximum attempt count',
                 completed_at = $1::timestamptz,
                 updated_at = $1::timestamptz
             FROM exhausted_candidate
             WHERE command.command_id = exhausted_candidate.candidate_command_id
             RETURNING command.command_id
           )
           SELECT exhausted.command_id AS "commandId",
                  exhausted_candidate.previous_attempt_count AS "attemptCount",
                  exhausted_candidate.previous_lease_owner AS "leaseOwner"
           FROM exhausted
           JOIN exhausted_candidate
             ON exhausted_candidate.candidate_command_id = exhausted.command_id`,
          [attemptedAt],
        );
        for (const command of exhausted.rows) {
          await client.query(
            `UPDATE gasless_command_attempts
             SET finished_at = $4::timestamptz,
                 outcome = 'dead_letter',
                 error_code = 'LEASE_ATTEMPTS_EXHAUSTED',
                 error_detail = 'Worker lease expired after the maximum attempt count'
             WHERE command_id = $1 AND attempt_number = $2 AND lease_owner = $3
               AND finished_at IS NULL`,
            [command.commandId, command.attemptCount, command.leaseOwner, attemptedAt],
          );
        }

        const result = await client.query<
          GaslessCommandRow & {
            previousStatus: GaslessCommandStatus;
            previousLeaseOwner: string | null;
            previousAttemptCount: number;
          }
        >(
          `WITH candidate AS (
             SELECT command_id AS candidate_command_id,
                    status AS previous_status,
                    lease_owner AS previous_lease_owner,
                    attempt_count AS previous_attempt_count
             FROM gasless_commands
             WHERE (
               (status = 'pending' AND next_attempt_at <= $2::timestamptz)
               OR (status = 'leased' AND lease_expires_at <= $2::timestamptz)
             )
               AND attempt_count < max_attempts
             ORDER BY next_attempt_at ASC, created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           ), claimed AS (
             UPDATE gasless_commands AS command
             SET status = 'leased',
                 attempt_count = attempt_count + 1,
                 lease_owner = $1,
                 lease_expires_at = $3::timestamptz,
                 updated_at = $2::timestamptz
             FROM candidate
             WHERE command.command_id = candidate.candidate_command_id
             RETURNING command.*
           )
           SELECT ${GASLESS_COMMAND_COLUMNS},
                  candidate.previous_status AS "previousStatus",
                  candidate.previous_lease_owner AS "previousLeaseOwner",
                  candidate.previous_attempt_count AS "previousAttemptCount"
           FROM claimed
           JOIN candidate ON candidate.candidate_command_id = claimed.command_id`,
          [leaseOwner, attemptedAt, leaseExpiresAt],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return null;
        }
        if (row.previousStatus === 'leased' && row.previousLeaseOwner) {
          await client.query(
            `UPDATE gasless_command_attempts
             SET finished_at = $4::timestamptz,
                 outcome = 'lease_expired',
                 error_code = 'LEASE_EXPIRED',
                 error_detail = 'Worker lease expired before attempt completion'
             WHERE command_id = $1 AND attempt_number = $2 AND lease_owner = $3
               AND finished_at IS NULL`,
            [row.commandId, row.previousAttemptCount, row.previousLeaseOwner, attemptedAt],
          );
        }
        await client.query(
          `INSERT INTO gasless_command_attempts (
             command_id, attempt_number, lease_owner, started_at
           ) VALUES ($1, $2, $3, $4)`,
          [row.commandId, row.attemptCount, leaseOwner, attemptedAt],
        );
        await client.query('COMMIT');
        return mapGaslessCommand(row);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async renewLease(commandId, leaseOwner, leaseExpiresAt) {
      const result = await pool.query(
        `UPDATE gasless_commands
         SET lease_expires_at = $3::timestamptz, updated_at = NOW()
         WHERE command_id = $1 AND status = 'leased' AND lease_owner = $2`,
        [commandId, leaseOwner, leaseExpiresAt],
      );
      return result.rowCount === 1;
    },

    markCompleted(commandId, leaseOwner, completedAt, result, transactionHash = null) {
      return finishAttempt(
        commandId,
        leaseOwner,
        completedAt,
        'completed',
        `status = 'completed', result = $4::jsonb, transaction_hash = $5,
         completed_at = $3::timestamptz,
         last_error_code = NULL, last_error_detail = NULL`,
        [JSON.stringify(result), transactionHash],
        { transactionHash },
      );
    },

    markOutcomePending(commandId, leaseOwner, completedAt, transactionHash) {
      return finishAttempt(
        commandId,
        leaseOwner,
        completedAt,
        'outcome_pending',
        `status = 'outcome_pending', transaction_hash = $4, completed_at = NULL`,
        [transactionHash],
        { transactionHash },
      );
    },

    markFailed(
      commandId,
      leaseOwner,
      completedAt,
      errorCode,
      errorDetail,
      nextAttemptAt,
      deadLetter,
    ) {
      return finishAttempt(
        commandId,
        leaseOwner,
        completedAt,
        deadLetter ? 'dead_letter' : 'retry_scheduled',
        `status = $4, next_attempt_at = $5::timestamptz, last_error_code = $6,
         last_error_detail = $7,
         completed_at = CASE WHEN $4 = 'dead_letter' THEN $3::timestamptz ELSE NULL END`,
        [deadLetter ? 'dead_letter' : 'pending', nextAttemptAt, errorCode, errorDetail],
        { errorCode, errorDetail },
      );
    },

    async resolveTransactionOutcome(
      applicationRequestId,
      transactionHash,
      outcomeStatus,
      observedAt,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{
          commandId: string;
          previousStatus: GaslessCommandStatus;
          attemptCount: number;
          leaseOwner: string | null;
        }>(
          `WITH candidate AS (
             SELECT command_id, status, attempt_count, lease_owner
             FROM gasless_commands
             WHERE application_request_id = $1
               AND status IN ('leased', 'outcome_pending', 'dead_letter')
               AND (transaction_hash IS NULL OR transaction_hash = $2)
             FOR UPDATE
           ), updated AS (
             UPDATE gasless_commands AS command
             SET status = CASE
                   WHEN $3 = 'confirmed' THEN 'completed'
                   WHEN $3 = 'reverted' THEN 'failed'
                   ELSE 'outcome_pending'
                 END,
                 transaction_hash = $2,
                 result = CASE
                   WHEN $3 IN ('confirmed', 'reverted')
                     THEN jsonb_build_object(
                       'transactionHash', $2::text,
                       'outcomeStatus', $3::text,
                       'recovered', true,
                       'rebroadcastAllowed', false
                     )
                   ELSE result
                 END,
                 completed_at = CASE WHEN $3 IN ('confirmed', 'reverted')
                   THEN $4::timestamptz ELSE NULL END,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error_code = NULL,
                 last_error_detail = NULL,
                 updated_at = $4::timestamptz
             FROM candidate
             WHERE command.command_id = candidate.command_id
             RETURNING command.command_id
           )
           SELECT updated.command_id AS "commandId",
                  candidate.status AS "previousStatus",
                  candidate.attempt_count AS "attemptCount",
                  candidate.lease_owner AS "leaseOwner"
           FROM updated
           JOIN candidate ON candidate.command_id = updated.command_id`,
          [applicationRequestId, transactionHash, outcomeStatus, observedAt],
        );
        const updated = result.rows[0];
        if (updated?.previousStatus === 'leased' && updated.leaseOwner) {
          await client.query(
            `UPDATE gasless_command_attempts
             SET finished_at = $4::timestamptz,
                 outcome = CASE
                   WHEN $6 IN ('confirmed', 'reverted') THEN 'outcome_resolved'
                   ELSE 'outcome_pending'
                 END,
                 transaction_hash = $5
             WHERE command_id = $1 AND attempt_number = $2 AND lease_owner = $3
               AND finished_at IS NULL`,
            [
              updated.commandId,
              updated.attemptCount,
              updated.leaseOwner,
              observedAt,
              transactionHash,
              outcomeStatus,
            ],
          );
        }
        await client.query('COMMIT');
        if (updated) return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const existing = await getByClause('application_request_id', applicationRequestId);
      return Boolean(
        existing &&
        existing.transactionHash === transactionHash &&
        ((outcomeStatus === 'confirmed' && existing.status === 'completed') ||
          (outcomeStatus === 'reverted' && existing.status === 'failed') ||
          ((outcomeStatus === 'broadcast_unknown' || outcomeStatus === 'confirmation_pending') &&
            existing.status === 'outcome_pending')),
      );
    },

    async listDeadLetters(limit) {
      const result = await pool.query<GaslessCommandRow>(
        `SELECT ${GASLESS_COMMAND_COLUMNS}
         FROM gasless_commands
         WHERE status = 'dead_letter'
         ORDER BY updated_at ASC, created_at ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => {
        const { payload: _payload, result: _result, ...record } = mapGaslessCommand(row);
        return record;
      });
    },

    async redriveDeadLetter(commandId, requestedAt, auditEntry) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<GaslessCommandRow>(
          `UPDATE gasless_commands AS command
           SET status = 'pending',
               max_attempts = attempt_count + 1,
               next_attempt_at = $2::timestamptz,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = NULL,
               last_error_detail = NULL,
               completed_at = NULL,
               updated_at = $2::timestamptz
           WHERE command_id = $1
             AND status = 'dead_letter'
             AND transaction_hash IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM gasless_transaction_outcomes AS outcome
               WHERE outcome.application_request_id = command.application_request_id
             )
           RETURNING ${GASLESS_COMMAND_COLUMNS}`,
          [commandId, requestedAt],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('ROLLBACK');
          return null;
        }
        await insertAuditLogWithClient(client, auditEntry);
        await client.query('COMMIT');
        return mapGaslessCommand(row);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async getQueueStats(now) {
      const result = await pool.query<{
        pending: string;
        leased: string;
        outcomePending: string;
        deadLetter: string;
        expiredLeases: string;
        oldestPendingAt: Date | null;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
           COUNT(*) FILTER (WHERE status = 'leased')::text AS leased,
           COUNT(*) FILTER (WHERE status = 'outcome_pending')::text AS "outcomePending",
           COUNT(*) FILTER (WHERE status = 'dead_letter')::text AS "deadLetter",
           COUNT(*) FILTER (WHERE status = 'leased' AND lease_expires_at <= $1)::text AS "expiredLeases",
           MIN(created_at) FILTER (WHERE status = 'pending') AS "oldestPendingAt"
         FROM gasless_commands`,
        [now],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Failed to read gasless command queue statistics');
      return {
        pending: Number(row.pending),
        leased: Number(row.leased),
        outcomePending: Number(row.outcomePending),
        deadLetter: Number(row.deadLetter),
        expiredLeases: Number(row.expiredLeases),
        oldestPendingAt: row.oldestPendingAt?.toISOString() ?? null,
      };
    },
  };
}
