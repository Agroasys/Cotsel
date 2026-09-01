/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { AdminActor, UserProfile, UserRole } from '../../types';
import { recordAdminAuditEvent } from './adminAudit';
import {
  insertTrustedProfileRow,
  queryProfileByAccountIdForUpdate,
  revokeActiveSessionsForUser,
} from './profileRows';

export async function grantBreakGlassAdmin(
  pool: Pool,
  input: {
    accountId: string;
    baseRole: Exclude<UserRole, 'admin'>;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
    actor: AdminActor;
    reason: string;
    ttlSeconds: number;
  },
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await queryProfileByAccountIdForUpdate(client, input.accountId);
    if (previous?.baseRole === 'admin') {
      throw new Error('Break-glass is only valid for non-admin base roles');
    }

    if (!previous) {
      await insertTrustedProfileRow(client, {
        accountId: input.accountId,
        role: input.baseRole,
        orgId: input.orgId,
        email: input.email,
        walletAddress: input.walletAddress,
      });
    }

    await client.query(
      `UPDATE user_profiles
       SET break_glass_role = 'admin',
           break_glass_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           break_glass_granted_at = NOW(),
           break_glass_granted_by = $3,
           break_glass_reason = $4,
           break_glass_revoked_at = NULL,
           break_glass_revoked_by = NULL,
           break_glass_reviewed_at = NULL,
           break_glass_reviewed_by = NULL,
           org_id = COALESCE($5, org_id),
           wallet_address = COALESCE($6, wallet_address),
           email = COALESCE($7, email),
           active = TRUE,
           updated_at = NOW()
       WHERE account_id = $1`,
      [
        input.accountId,
        input.ttlSeconds,
        input.actor.id,
        input.reason,
        input.orgId,
        input.walletAddress,
        input.email,
      ],
    );

    const profile = await queryProfileByAccountIdForUpdate(client, input.accountId);
    if (!profile) {
      throw new Error('Failed to load break-glass profile state');
    }
    const revokedSessions = await revokeActiveSessionsForUser(client, profile.id);

    await recordAdminAuditEvent(client, {
      accountId: input.accountId,
      targetUserId: profile.id,
      action: 'break_glass_granted',
      actor: input.actor,
      previousRole: previous?.role ?? previous?.baseRole ?? null,
      newRole: 'admin',
      reason: input.reason,
      breakGlassExpiresAt: profile.breakGlassExpiresAt,
      metadata: {
        baseRole: profile.baseRole,
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

export async function revokeBreakGlassAdmin(
  pool: Pool,
  accountId: string,
  actor: AdminActor,
  reason: string,
  action: 'break_glass_revoked' | 'break_glass_expired' = 'break_glass_revoked',
): Promise<UserProfile | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!previous?.breakGlassRole) {
      await client.query('COMMIT');
      return null;
    }

    await client.query(
      `UPDATE user_profiles
       SET break_glass_role = NULL,
           break_glass_expires_at = NULL,
           break_glass_revoked_at = NOW(),
           break_glass_revoked_by = $2,
           updated_at = NOW()
       WHERE account_id = $1`,
      [accountId, actor.id],
    );

    const profile = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!profile) {
      throw new Error('Failed to load revoked break-glass profile state');
    }
    const revokedSessions = await revokeActiveSessionsForUser(client, profile.id);

    await recordAdminAuditEvent(client, {
      accountId,
      targetUserId: profile.id,
      action,
      actor,
      previousRole: 'admin',
      newRole: profile.baseRole,
      reason,
      metadata: {
        baseRole: profile.baseRole,
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

export async function reviewBreakGlassAdmin(
  pool: Pool,
  accountId: string,
  actor: AdminActor,
  reason: string,
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!previous?.breakGlassGrantedAt) {
      throw new Error('No break-glass event found for account');
    }
    const hasClosureEvidence =
      previous.breakGlassRevokedAt !== null ||
      (previous.breakGlassExpiresAt !== null &&
        previous.breakGlassExpiresAt.getTime() <= Date.now());
    if (!hasClosureEvidence) {
      throw new Error('Break-glass review is only valid for revoked or expired grants');
    }

    await client.query(
      `UPDATE user_profiles
       SET break_glass_reviewed_at = NOW(),
           break_glass_reviewed_by = $2,
           updated_at = NOW()
       WHERE account_id = $1`,
      [accountId, actor.id],
    );

    const profile = await queryProfileByAccountIdForUpdate(client, accountId);
    if (!profile) {
      throw new Error('Failed to load reviewed break-glass profile state');
    }

    await recordAdminAuditEvent(client, {
      accountId,
      targetUserId: profile.id,
      action: 'break_glass_reviewed',
      actor,
      previousRole: previous.role,
      newRole: profile.role,
      reason,
      metadata: {
        reviewedAt: profile.breakGlassReviewedAt?.toISOString() ?? null,
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
