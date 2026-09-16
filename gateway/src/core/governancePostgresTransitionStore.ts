/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { GatewayError } from '../errors';
import type { GovernanceActionRecord, GovernanceActionRow } from './governanceStore';
import { mapGovernanceActionRow } from './governanceStore';
import { governanceActionSelectProjection } from './governancePostgresStore';
import {
  type GovernanceConfirmationCommit,
  type GovernanceMonitorClaim,
  type GovernanceTransitionStore,
  resolveGovernanceConfirmationCommit,
} from './governanceTransitionStore';
import { insertGovernanceAuditLog } from './governanceWriteStore';

interface LockedGovernanceActionRow extends GovernanceActionRow {
  transitionVersion: string | number;
}

async function rollback(client: PoolClient, original: unknown): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    const originalMessage = original instanceof Error ? original.message : String(original);
    const rollbackMessage =
      rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(
      `Governance transition rollback failed: ${originalMessage}; rollback error: ${rollbackMessage}`,
    );
  }
  throw original;
}

function transitionParams(action: GovernanceActionRecord): unknown[] {
  return [
    action.status,
    action.txHash,
    action.blockNumber,
    action.broadcastAt,
    action.finalSignerWallet ?? null,
    action.verificationState ?? 'not_started',
    action.verificationError ?? null,
    action.verifiedAt ?? null,
    action.monitoringState ?? 'not_started',
    action.errorCode,
    action.errorMessage,
    action.executedAt,
  ];
}

function mapLockedRow(row: LockedGovernanceActionRow): {
  action: GovernanceActionRecord;
  transitionVersion: number;
} {
  const transitionVersion = Number(row.transitionVersion);
  if (!Number.isSafeInteger(transitionVersion) || transitionVersion < 0) {
    throw new Error('Governance transition version is invalid');
  }
  return { action: mapGovernanceActionRow(row), transitionVersion };
}

async function loadForUpdate(
  client: PoolClient,
  actionId: string,
): Promise<GovernanceActionRecord | null> {
  const result = await client.query<GovernanceActionRow>(
    `SELECT ${governanceActionSelectProjection}
     FROM governance_actions
     WHERE action_id = $1
     FOR UPDATE`,
    [actionId],
  );
  return result.rows[0] ? mapGovernanceActionRow(result.rows[0]) : null;
}

async function updateConfirmedAction(
  client: PoolClient,
  action: GovernanceActionRecord,
): Promise<GovernanceActionRecord> {
  const result = await client.query<GovernanceActionRow>(
    `UPDATE governance_actions
     SET status = $1,
         tx_hash = $2,
         block_number = $3,
         broadcast_at = $4,
         final_signer_wallet = $5,
         verification_state = $6,
         verification_error = $7,
         verified_at = $8,
         monitoring_state = $9,
         error_code = $10,
         error_message = $11,
         executed_at = $12,
         transition_version = transition_version + 1,
         updated_at = NOW()
     WHERE action_id = $13
     RETURNING ${governanceActionSelectProjection}`,
    [...transitionParams(action), action.actionId],
  );
  if (!result.rows[0]) throw new Error(`Governance action ${action.actionId} disappeared`);
  return mapGovernanceActionRow(result.rows[0]);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

export function createPostgresGovernanceTransitionStore(pool: Pool): GovernanceTransitionStore {
  return {
    async commitConfirmation(input: GovernanceConfirmationCommit) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await loadForUpdate(client, input.actionId);
        const resolved = resolveGovernanceConfirmationCommit(current, input);
        if (resolved.idempotent) {
          await client.query('COMMIT');
          return resolved.action;
        }
        const stored = await updateConfirmedAction(client, resolved.action);
        await insertGovernanceAuditLog(client, input.auditEntry);
        await client.query('COMMIT');
        return stored;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isUniqueViolation(rolledBackError)) {
            throw new GatewayError(
              409,
              'CONFLICT',
              'Transaction hash is already bound to another governance action',
              { actionId: input.actionId, transactionHash: input.transactionHash },
            );
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
      throw new Error('Unreachable governance confirmation state');
    },

    async claimMonitorActions(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<LockedGovernanceActionRow>(
          `SELECT ${governanceActionSelectProjection},
                  transition_version AS "transitionVersion"
           FROM governance_actions
           WHERE status IN ('broadcast_pending_verification', 'broadcast')
             AND (monitor_lease_expires_at IS NULL OR monitor_lease_expires_at <= $1)
           ORDER BY updated_at ASC, action_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2`,
          [input.claimedAt, input.limit],
        );

        const claims: GovernanceMonitorClaim[] = [];
        for (const row of result.rows) {
          const locked = mapLockedRow(row);
          const leaseToken = randomUUID();
          const transitionVersion = locked.transitionVersion + 1;
          await client.query(
            `UPDATE governance_actions
             SET monitor_lease_owner = $2,
                 monitor_lease_token = $3,
                 monitor_lease_expires_at = $4,
                 transition_version = $5,
                 updated_at = NOW()
             WHERE action_id = $1`,
            [
              locked.action.actionId,
              input.workerId,
              leaseToken,
              input.leaseExpiresAt,
              transitionVersion,
            ],
          );
          claims.push({
            action: locked.action,
            workerId: input.workerId,
            leaseToken,
            transitionVersion,
            leaseExpiresAt: input.leaseExpiresAt,
          });
        }
        await client.query('COMMIT');
        return claims;
      } catch (error) {
        return rollback(client, error);
      } finally {
        client.release();
      }
    },

    async completeMonitorClaim(claim, transition, auditEntry, completedAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<GovernanceActionRow>(
          `UPDATE governance_actions
           SET status = $1,
               tx_hash = $2,
               block_number = $3,
               broadcast_at = $4,
               final_signer_wallet = $5,
               verification_state = $6,
               verification_error = $7,
               verified_at = $8,
               monitoring_state = $9,
               error_code = $10,
               error_message = $11,
               executed_at = $12,
               monitor_lease_owner = NULL,
               monitor_lease_token = NULL,
               monitor_lease_expires_at = NULL,
               transition_version = transition_version + 1,
               updated_at = NOW()
           WHERE action_id = $13
             AND monitor_lease_owner = $14
             AND monitor_lease_token = $15
             AND monitor_lease_expires_at > $16
             AND transition_version = $17
             AND status = $18
             AND tx_hash IS NOT DISTINCT FROM $19
           RETURNING ${governanceActionSelectProjection}`,
          [
            ...transitionParams(transition),
            claim.action.actionId,
            claim.workerId,
            claim.leaseToken,
            completedAt,
            claim.transitionVersion,
            claim.action.status,
            claim.action.txHash,
          ],
        );
        if (!result.rows[0]) {
          await client.query('COMMIT');
          return null;
        }
        await insertGovernanceAuditLog(client, auditEntry);
        await client.query('COMMIT');
        return mapGovernanceActionRow(result.rows[0]);
      } catch (error) {
        return rollback(client, error);
      } finally {
        client.release();
      }
    },

    async releaseMonitorClaim(claim) {
      const result = await pool.query(
        `UPDATE governance_actions
         SET monitor_lease_owner = NULL,
             monitor_lease_token = NULL,
             monitor_lease_expires_at = NULL,
             transition_version = transition_version + 1,
             updated_at = NOW()
         WHERE action_id = $1
           AND monitor_lease_owner = $2
           AND monitor_lease_token = $3
           AND transition_version = $4`,
        [claim.action.actionId, claim.workerId, claim.leaseToken, claim.transitionVersion],
      );
      return result.rowCount === 1;
    },
  };
}
