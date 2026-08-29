/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AdminActor, AdminAuditAction, UserProfile, UserRole } from '../../types';
import {
  USER_PROFILE_FIELDS,
  insertTrustedProfileRow,
  queryProfileByAccountIdForUpdate,
  revokeActiveSessionsForUser,
  updateTrustedProfileRow,
} from './profileRows';

export async function recordAdminAuditEvent(
  client: Pool | PoolClient,
  input: {
    accountId: string;
    targetUserId?: string | null;
    action: AdminAuditAction;
    actor: AdminActor;
    previousRole?: string | null;
    newRole?: string | null;
    reason: string;
    breakGlassExpiresAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO auth_admin_audit_events (
       account_id,
       target_user_id,
       action,
       actor_type,
       actor_id,
       previous_role,
       new_role,
       reason,
       break_glass_expires_at,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.accountId,
      input.targetUserId ?? null,
      input.action,
      input.actor.type,
      input.actor.id,
      input.previousRole ?? null,
      input.newRole ?? null,
      input.reason,
      input.breakGlassExpiresAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export interface AdminAuditEventRecord {
  id: string;
  accountId: string;
  targetUserId: string | null;
  action: AdminAuditAction;
  actorType: AdminActor['type'];
  actorId: string;
  previousRole: string | null;
  newRole: string | null;
  reason: string;
  breakGlassExpiresAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorProfileAuthoritySnapshot {
  profile: UserProfile;
  recentAuditEvents: AdminAuditEventRecord[];
}

interface AdminAuditEventRow {
  id: string;
  accountId: string;
  targetUserId: string | null;
  action: AdminAuditAction;
  actorType: AdminActor['type'];
  actorId: string;
  previousRole: string | null;
  newRole: string | null;
  reason: string;
  breakGlassExpiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

function mapAdminAuditEvent(row: AdminAuditEventRow): AdminAuditEventRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    targetUserId: row.targetUserId,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    previousRole: row.previousRole,
    newRole: row.newRole,
    reason: row.reason,
    breakGlassExpiresAt: row.breakGlassExpiresAt?.toISOString() ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAdminAuditEvents(
  pool: Pool | PoolClient,
  input: { accountId?: string; limit?: number } = {},
): Promise<AdminAuditEventRecord[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const params: unknown[] = [];
  const where: string[] = [];

  if (input.accountId) {
    params.push(input.accountId);
    where.push(`account_id = $${params.length}`);
  }

  params.push(limit);
  const result = await pool.query<AdminAuditEventRow>(
    `SELECT id::text,
            account_id AS "accountId",
            target_user_id::text AS "targetUserId",
            action,
            actor_type AS "actorType",
            actor_id AS "actorId",
            previous_role AS "previousRole",
            new_role AS "newRole",
            reason,
            break_glass_expires_at AS "breakGlassExpiresAt",
            metadata,
            created_at AS "createdAt"
     FROM auth_admin_audit_events
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(mapAdminAuditEvent);
}

export async function listOperatorAuthorityProfiles(
  pool: Pool,
  input: { limit?: number } = {},
): Promise<OperatorProfileAuthoritySnapshot[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles
     WHERE role = 'admin'
        OR break_glass_role IS NOT NULL
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $1`,
    [limit],
  );

  return Promise.all(
    result.rows.map(async (profile) => ({
      profile,
      recentAuditEvents: await listAdminAuditEvents(pool, {
        accountId: profile.accountId,
        limit: 10,
      }),
    })),
  );
}

export async function provisionProfileWithAudit(
  pool: Pool,
  input: {
    accountId: string;
    role: UserRole;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
    actor: AdminActor;
    reason: string;
  },
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await queryProfileByAccountIdForUpdate(client, input.accountId);
    const profile = previous
      ? await updateTrustedProfileRow(client, previous.id, {
          accountId: input.accountId,
          role: input.role,
          orgId: input.orgId,
          email: input.email,
          walletAddress: input.walletAddress,
        })
      : await insertTrustedProfileRow(client, {
          accountId: input.accountId,
          role: input.role,
          orgId: input.orgId,
          email: input.email,
          walletAddress: input.walletAddress,
        });

    if (!profile.active) {
      await client.query(
        `UPDATE user_profiles SET active = TRUE, updated_at = NOW() WHERE id = $1`,
        [profile.id],
      );
    }

    await client.query(
      `UPDATE user_profiles
       SET break_glass_role = NULL,
           break_glass_expires_at = NULL,
           break_glass_revoked_at = CASE WHEN break_glass_role IS NOT NULL THEN NOW() ELSE break_glass_revoked_at END,
           break_glass_revoked_by = CASE WHEN break_glass_role IS NOT NULL THEN $2 ELSE break_glass_revoked_by END,
           updated_at = NOW()
       WHERE id = $1`,
      [profile.id, input.actor.id],
    );

    const updated = await queryProfileByAccountIdForUpdate(client, input.accountId);
    if (!updated) {
      throw new Error('Failed to load provisioned profile');
    }

    const revokedSessions = previous ? await revokeActiveSessionsForUser(client, updated.id) : 0;

    await recordAdminAuditEvent(client, {
      accountId: input.accountId,
      targetUserId: updated.id,
      action: previous ? 'profile_role_updated' : 'profile_provisioned',
      actor: input.actor,
      previousRole: previous?.baseRole ?? previous?.role ?? null,
      newRole: input.role,
      reason: input.reason,
      metadata: {
        previousActive: previous?.active ?? null,
        revokedSessions,
        orgId: updated.orgId,
      },
    });

    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deactivateProfileWithAudit(
  pool: Pool,
  accountId: string,
  actor: AdminActor,
  reason: string,
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!previous) {
      throw new Error('Profile not found');
    }

    await client.query(
      `UPDATE user_profiles
       SET active = FALSE,
           break_glass_role = NULL,
           break_glass_expires_at = NULL,
           break_glass_revoked_at = CASE WHEN break_glass_role IS NOT NULL THEN NOW() ELSE break_glass_revoked_at END,
           break_glass_revoked_by = CASE WHEN break_glass_role IS NOT NULL THEN $2 ELSE break_glass_revoked_by END,
           updated_at = NOW()
       WHERE account_id = $1`,
      [accountId, actor.id],
    );

    const profile = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!profile) {
      throw new Error('Failed to load deactivated profile state');
    }
    const revokedSessions = await revokeActiveSessionsForUser(client, profile.id);

    await recordAdminAuditEvent(client, {
      accountId,
      targetUserId: profile.id,
      action: 'profile_deactivated',
      actor,
      previousRole: previous.role,
      newRole: profile.baseRole,
      reason,
      metadata: {
        previousActive: previous.active,
        revokedSessions,
      },
    });

    await client.query('COMMIT');
    return profile;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
