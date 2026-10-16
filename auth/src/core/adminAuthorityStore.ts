/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { CallerSafeError } from '@agroasys/shared-http';
import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  AdminActor,
  AdminAuthorityChangeKind,
  AdminAuthorityChangeRecord,
  UserProfile,
  UserRole,
} from '../types';
import { recordAdminAuditEvent } from '../database/queries/adminAudit';
import {
  insertTrustedProfileRow,
  queryActiveAdminGrant,
  queryProfileByAccountIdForUpdate,
  revokeActiveSessionsForUser,
  updateTrustedProfileRow,
} from '../database/queries/profileRows';
import { canonicalControlPrincipal } from './controlPrincipal';

export interface ProposeAdminAuthorityChangeInput {
  accountId: string;
  change: AdminAuthorityChangeKind;
  environment: string;
  orgId: string | null;
  grantExpiresAt: Date | null;
  resultingRole: UserRole;
  approvalTicket: string;
  reason: string;
  actor: AdminActor;
}

export interface DecideAdminAuthorityChangeInput {
  changeId: string;
  actor: AdminActor;
  reason: string;
}

export interface AdminAuthorityStore {
  list(input?: {
    accountId?: string;
    state?: AdminAuthorityChangeRecord['state'];
    limit?: number;
  }): Promise<AdminAuthorityChangeRecord[]>;
  propose(input: ProposeAdminAuthorityChangeInput): Promise<AdminAuthorityChangeRecord>;
  approve(
    input: DecideAdminAuthorityChangeInput & { evidenceDigest: string },
  ): Promise<AdminAuthorityChangeRecord>;
  cancel(input: DecideAdminAuthorityChangeInput): Promise<AdminAuthorityChangeRecord>;
}

interface ChangeRow {
  changeId: string;
  accountId: string;
  change: AdminAuthorityChangeKind;
  environment: string;
  orgId: string | null;
  grantExpiresAt: Date | null;
  resultingRole: UserRole;
  approvalTicket: string;
  reason: string;
  evidenceDigest: string;
  state: AdminAuthorityChangeRecord['state'];
  proposedBy: string;
  proposedByKey: string;
  proposedAt: Date;
  appliedBy: string | null;
  appliedByKey: string | null;
  appliedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
}

const CHANGE_COLUMNS = `
  id::text AS "changeId",
  account_id AS "accountId",
  change,
  environment,
  org_id AS "orgId",
  grant_expires_at AS "grantExpiresAt",
  resulting_role AS "resultingRole",
  approval_ticket AS "approvalTicket",
  reason,
  evidence_digest AS "evidenceDigest",
  state,
  proposed_by AS "proposedBy",
  proposed_by_key AS "proposedByKey",
  proposed_at AS "proposedAt",
  applied_by AS "appliedBy",
  applied_by_key AS "appliedByKey",
  applied_at AS "appliedAt",
  cancelled_by AS "cancelledBy",
  cancelled_at AS "cancelledAt",
  cancelled_reason AS "cancelledReason"`;

const SUBJECT = 'Admin authority';

function mapRow(row: ChangeRow): AdminAuthorityChangeRecord {
  return {
    ...row,
    grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
    proposedAt: row.proposedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

function changeDigest(input: ProposeAdminAuthorityChangeInput, proposer: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'v1',
        input.accountId,
        input.change,
        input.environment,
        input.orgId,
        input.grantExpiresAt?.toISOString() ?? null,
        input.resultingRole,
        input.approvalTicket,
        proposer,
      ]),
    )
    .digest('hex');
}

/** The authority an account holds, recorded before and after each change. */
async function authoritySnapshot(
  client: PoolClient,
  profile: UserProfile | null,
  environment: string,
) {
  return {
    profileExists: profile !== null,
    active: profile?.active ?? null,
    baseRole: profile?.baseRole ?? null,
    orgId: profile?.orgId ?? null,
    adminGrantActive: profile
      ? profile.baseRole === 'admin' &&
        (await queryActiveAdminGrant(client, profile.accountId, environment))
      : false,
  };
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockPendingChange(client: PoolClient, changeId: string): Promise<ChangeRow> {
  const existing = await client.query<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM admin_authority_changes WHERE id = $1 FOR UPDATE`,
    [changeId],
  );
  const row = existing.rows[0];
  if (!row) throw new CallerSafeError('Admin authority change not found');
  if (row.state !== 'pending') throw new CallerSafeError('Admin authority change is not pending');
  return row;
}

/**
 * Two-person store for durable administrator authority. `environment` is the
 * environment this service runs in; changes for any other environment are
 * refused, so authority approved in one environment never applies in another.
 */
export function createPostgresAdminAuthorityStore(
  pool: Pool,
  environment: string,
): AdminAuthorityStore {
  return {
    async list(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.accountId) {
        params.push(input.accountId);
        conditions.push(`account_id = $${params.length}`);
      }
      if (input.state) {
        params.push(input.state);
        conditions.push(`state = $${params.length}`);
      }
      params.push(limit);
      const result = await pool.query<ChangeRow>(
        `SELECT ${CHANGE_COLUMNS}
         FROM admin_authority_changes
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY proposed_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapRow);
    },

    propose(input) {
      return withTransaction(pool, async (client) => {
        const proposer = canonicalControlPrincipal(input.actor, SUBJECT);
        if (input.environment !== environment) {
          throw new CallerSafeError(
            `Admin authority changes for environment ${input.environment} cannot be made in ${environment}`,
          );
        }
        const profile = await queryProfileByAccountIdForUpdate(client, input.accountId);
        if (input.change === 'grant' && profile && !profile.active) {
          throw new CallerSafeError('Admin grants require an active profile; reactivate it first');
        }
        if (input.change === 'revoke' && profile?.baseRole !== 'admin') {
          throw new CallerSafeError('Admin revocation requires a durable admin profile');
        }

        const evidenceDigest = changeDigest(input, proposer);
        const pending = await client.query<ChangeRow>(
          `SELECT ${CHANGE_COLUMNS}
           FROM admin_authority_changes
           WHERE account_id = $1 AND environment = $2 AND state = 'pending'
           FOR UPDATE`,
          [input.accountId, input.environment],
        );
        if (pending.rows[0]) {
          if (pending.rows[0].evidenceDigest !== evidenceDigest) {
            throw new CallerSafeError(
              'Admin authority change conflict: another change is pending for this account',
            );
          }
          return mapRow(pending.rows[0]);
        }

        const inserted = await client.query<ChangeRow>(
          `INSERT INTO admin_authority_changes (
             account_id, change, environment, org_id, grant_expires_at, resulting_role,
             approval_ticket, reason, evidence_digest, proposed_by, proposed_by_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${CHANGE_COLUMNS}`,
          [
            input.accountId,
            input.change,
            input.environment,
            input.orgId,
            input.grantExpiresAt,
            input.resultingRole,
            input.approvalTicket,
            input.reason,
            evidenceDigest,
            proposer,
            input.actor.id,
          ],
        );
        const record = mapRow(inserted.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: record.accountId,
          targetUserId: profile?.id ?? null,
          action: 'admin_authority_change_proposed',
          actor: input.actor,
          previousRole: profile?.baseRole ?? null,
          newRole: record.resultingRole,
          reason: record.reason,
          metadata: {
            changeId: record.changeId,
            change: record.change,
            environment: record.environment,
            orgId: record.orgId,
            grantExpiresAt: record.grantExpiresAt,
            approvalTicket: record.approvalTicket,
            proposedBy: record.proposedBy,
            proposedByKey: record.proposedByKey,
            evidenceDigest: record.evidenceDigest,
            before: await authoritySnapshot(client, profile, environment),
          },
        });
        return record;
      });
    },

    approve(input) {
      return withTransaction(pool, async (client) => {
        const approver = canonicalControlPrincipal(input.actor, SUBJECT);
        const row = await lockPendingChange(client, input.changeId);
        if (row.proposedBy === approver) {
          throw new CallerSafeError(
            'Admin authority change proposer cannot approve the same change',
          );
        }
        if (row.evidenceDigest !== input.evidenceDigest) {
          throw new CallerSafeError(
            'Admin authority approval digest does not match the pending change',
          );
        }
        if (row.environment !== environment) {
          throw new CallerSafeError(
            `Admin authority change is bound to environment ${row.environment}`,
          );
        }
        if (row.change === 'grant' && row.grantExpiresAt!.getTime() <= Date.now()) {
          throw new CallerSafeError('Admin authority grant expired before approval');
        }

        const profile = await queryProfileByAccountIdForUpdate(client, row.accountId);
        const before = await authoritySnapshot(client, profile, environment);
        let targetUserId: string;
        let revokedSessions = 0;
        if (row.change === 'grant') {
          if (profile && !profile.active) {
            throw new CallerSafeError(
              'Admin grants require an active profile; reactivate it first',
            );
          }
          const fields = {
            accountId: row.accountId,
            role: 'admin' as const,
            orgId: row.orgId,
            email: null,
            walletAddress: null,
          };
          const granted = profile
            ? await updateTrustedProfileRow(client, profile.id, fields)
            : await insertTrustedProfileRow(client, fields);
          // Durable authority supersedes any temporary elevation.
          await client.query(
            `UPDATE user_profiles
             SET break_glass_role = NULL,
                 break_glass_expires_at = NULL,
                 break_glass_revoked_at = CASE WHEN break_glass_role IS NOT NULL THEN NOW() ELSE break_glass_revoked_at END,
                 break_glass_revoked_by = CASE WHEN break_glass_role IS NOT NULL THEN $2 ELSE break_glass_revoked_by END,
                 updated_at = NOW()
             WHERE id = $1`,
            [granted.id, approver],
          );
          targetUserId = granted.id;
        } else {
          if (profile?.baseRole !== 'admin') {
            throw new CallerSafeError('Admin revocation requires a durable admin profile');
          }
          await updateTrustedProfileRow(client, profile.id, {
            accountId: row.accountId,
            role: row.resultingRole,
            orgId: null,
            email: null,
            walletAddress: null,
          });
          revokedSessions = await revokeActiveSessionsForUser(client, profile.id);
          targetUserId = profile.id;
        }

        const updated = await client.query<ChangeRow>(
          `UPDATE admin_authority_changes
           SET state = 'applied', applied_by = $2, applied_by_key = $3, applied_at = clock_timestamp()
           WHERE id = $1 AND state = 'pending'
           RETURNING ${CHANGE_COLUMNS}`,
          [row.changeId, approver, input.actor.id],
        );
        const applied = mapRow(updated.rows[0]);
        const after = await authoritySnapshot(
          client,
          await queryProfileByAccountIdForUpdate(client, row.accountId),
          environment,
        );
        await recordAdminAuditEvent(client, {
          accountId: applied.accountId,
          targetUserId,
          action: 'admin_authority_change_applied',
          actor: input.actor,
          previousRole: before.baseRole,
          newRole: after.baseRole,
          reason: input.reason,
          metadata: {
            changeId: applied.changeId,
            change: applied.change,
            environment: applied.environment,
            orgId: applied.orgId,
            grantExpiresAt: applied.grantExpiresAt,
            approvalTicket: applied.approvalTicket,
            proposedBy: applied.proposedBy,
            proposedByKey: applied.proposedByKey,
            appliedBy: applied.appliedBy,
            appliedByKey: applied.appliedByKey,
            evidenceDigest: applied.evidenceDigest,
            revokedSessions,
            before,
            after,
          },
        });
        return applied;
      });
    },

    cancel(input) {
      return withTransaction(pool, async (client) => {
        const canceller = canonicalControlPrincipal(input.actor, SUBJECT);
        const row = await lockPendingChange(client, input.changeId);
        const updated = await client.query<ChangeRow>(
          `UPDATE admin_authority_changes
           SET state = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), cancelled_reason = $3
           WHERE id = $1 AND state = 'pending'
           RETURNING ${CHANGE_COLUMNS}`,
          [row.changeId, canceller, input.reason],
        );
        const cancelled = mapRow(updated.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: cancelled.accountId,
          targetUserId: null,
          action: 'admin_authority_change_cancelled',
          actor: input.actor,
          previousRole: null,
          newRole: null,
          reason: input.reason,
          metadata: {
            changeId: cancelled.changeId,
            change: cancelled.change,
            environment: cancelled.environment,
            proposedBy: cancelled.proposedBy,
            cancelledBy: cancelled.cancelledBy,
            evidenceDigest: cancelled.evidenceDigest,
          },
        });
        return cancelled;
      });
    },
  };
}
