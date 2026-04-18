/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AdminActor, AdminAuditAction, UserProfile, UserSession, UserRole } from '../types';

type SessionRow = Omit<UserSession, 'issuedAt' | 'expiresAt' | 'revokedAt'> & {
  issuedAt: number | string;
  expiresAt: number | string;
  revokedAt: number | string | null;
};

const USER_PROFILE_FIELDS = `
  id,
  account_id AS "accountId",
  wallet_address AS "walletAddress",
  email,
  CASE
    WHEN break_glass_role = 'admin'
      AND break_glass_expires_at IS NOT NULL
      AND break_glass_expires_at > NOW()
      AND break_glass_revoked_at IS NULL
    THEN 'admin'
    ELSE role
  END AS role,
  role AS "baseRole",
  org_id AS "orgId",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  active,
  break_glass_role AS "breakGlassRole",
  break_glass_expires_at AS "breakGlassExpiresAt",
  break_glass_granted_at AS "breakGlassGrantedAt",
  break_glass_granted_by AS "breakGlassGrantedBy",
  break_glass_reason AS "breakGlassReason",
  break_glass_revoked_at AS "breakGlassRevokedAt",
  break_glass_revoked_by AS "breakGlassRevokedBy",
  break_glass_reviewed_at AS "breakGlassReviewedAt",
  break_glass_reviewed_by AS "breakGlassReviewedBy"
`;

const LEGACY_ACCOUNT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSessionEpoch(
  value: number | string,
  field: 'issuedAt' | 'expiresAt' | 'revokedAt',
): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid ${field} session timestamp returned from database`);
}

export function normalizeSessionRow(row: SessionRow): UserSession {
  return {
    ...row,
    issuedAt: parseSessionEpoch(row.issuedAt, 'issuedAt'),
    expiresAt: parseSessionEpoch(row.expiresAt, 'expiresAt'),
    revokedAt: row.revokedAt === null ? null : parseSessionEpoch(row.revokedAt, 'revokedAt'),
  };
}

function isLegacyAccountIdPlaceholder(accountId: string): boolean {
  return LEGACY_ACCOUNT_ID_REGEX.test(accountId);
}

async function findTrustedProfileByAccountId(
  client: PoolClient,
  accountId: string,
): Promise<UserProfile | null> {
  const result = await client.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles
     WHERE account_id = $1
     FOR UPDATE`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

async function findTrustedProfileByWalletAddress(
  client: PoolClient,
  walletAddress: string,
): Promise<UserProfile | null> {
  const result = await client.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles
     WHERE wallet_address = $1
     FOR UPDATE`,
    [walletAddress],
  );
  return result.rows[0] ?? null;
}

async function updateTrustedProfileRow(
  client: PoolClient,
  profileId: string,
  input: {
    accountId: string;
    role: UserRole;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
  },
): Promise<UserProfile> {
  const result = await client.query<UserProfile>(
    `UPDATE user_profiles
     SET account_id = $2,
         wallet_address = COALESCE($3, user_profiles.wallet_address),
         email = COALESCE($4, user_profiles.email),
         role = $5,
         org_id = COALESCE($6, user_profiles.org_id),
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${USER_PROFILE_FIELDS}`,
    [profileId, input.accountId, input.walletAddress, input.email, input.role, input.orgId],
  );
  return result.rows[0];
}

async function insertTrustedProfileRow(
  client: PoolClient,
  input: {
    accountId: string;
    role: UserRole;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
  },
): Promise<UserProfile> {
  const result = await client.query<UserProfile>(
    `INSERT INTO user_profiles (account_id, wallet_address, email, role, org_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING ${USER_PROFILE_FIELDS}`,
    [input.accountId, input.walletAddress, input.email, input.role, input.orgId],
  );
  return result.rows[0];
}

async function recordAdminAuditEvent(
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

async function queryProfileByAccountIdForUpdate(
  client: PoolClient,
  accountId: string,
): Promise<UserProfile | null> {
  return findTrustedProfileByAccountId(client, accountId);
}

async function revokeActiveSessionsForUser(
  client: Pool | PoolClient,
  userId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE user_sessions
     SET revoked_at = $1
     WHERE user_id = $2
       AND revoked_at IS NULL`,
    [Math.floor(Date.now() / 1000), userId],
  );
  return result.rowCount ?? 0;
}

//  Profile queries

export async function upsertProfile(
  pool: Pool,
  walletAddress: string,
  role: UserRole,
  orgId: string | null,
): Promise<UserProfile> {
  const result = await pool.query<UserProfile>(
    `INSERT INTO user_profiles (account_id, wallet_address, role, org_id, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())
     ON CONFLICT (wallet_address)
     DO UPDATE SET org_id = COALESCE(EXCLUDED.org_id, user_profiles.org_id),
                   updated_at = NOW()
     RETURNING ${USER_PROFILE_FIELDS}`,
    [walletAddress, role, orgId],
  );
  return result.rows[0];
}

export async function upsertTrustedProfile(
  pool: Pool,
  input: {
    accountId: string;
    role: UserRole;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
  },
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const accountMatch = await findTrustedProfileByAccountId(client, input.accountId);
    const walletMatch = input.walletAddress
      ? await findTrustedProfileByWalletAddress(client, input.walletAddress)
      : null;

    if (accountMatch && walletMatch && accountMatch.id !== walletMatch.id) {
      if (!isLegacyAccountIdPlaceholder(walletMatch.accountId)) {
        throw new Error('walletAddress is already linked to a different account');
      }
      if (accountMatch.walletAddress && accountMatch.walletAddress !== input.walletAddress) {
        throw new Error('trusted account already has a different linked wallet');
      }

      await client.query(
        `UPDATE user_sessions
         SET user_id = $1,
             wallet_address = COALESCE($2, wallet_address)
         WHERE user_id = $3`,
        [accountMatch.id, input.walletAddress, walletMatch.id],
      );
      await client.query(`DELETE FROM user_profiles WHERE id = $1`, [walletMatch.id]);
      const mergedProfile = await updateTrustedProfileRow(client, accountMatch.id, input);
      await client.query('COMMIT');
      return mergedProfile;
    }

    if (accountMatch) {
      const updatedProfile = await updateTrustedProfileRow(client, accountMatch.id, input);
      await client.query('COMMIT');
      return updatedProfile;
    }

    if (walletMatch) {
      if (
        walletMatch.accountId !== input.accountId &&
        !isLegacyAccountIdPlaceholder(walletMatch.accountId)
      ) {
        throw new Error('walletAddress is already linked to a different account');
      }

      const relinkedProfile = await updateTrustedProfileRow(client, walletMatch.id, input);
      await client.query('COMMIT');
      return relinkedProfile;
    }

    const insertedProfile = await insertTrustedProfileRow(client, input);
    await client.query('COMMIT');
    return insertedProfile;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findProfileByWallet(
  pool: Pool,
  walletAddress: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE wallet_address = $1`,
    [walletAddress],
  );
  return result.rows[0] ?? null;
}

export async function findProfileByAccountId(
  pool: Pool,
  accountId: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function findProfileById(pool: Pool, id: string): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function deactivateProfile(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE user_profiles SET active = FALSE, updated_at = NOW() WHERE id = $1`, [
    id,
  ]);
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

//  Session queries

export async function insertSession(
  client: Pool | PoolClient,
  sessionId: string,
  profile: UserProfile,
  expiresAt: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await client.query(
    `INSERT INTO user_sessions (session_id, user_id, wallet_address, role, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, profile.id, profile.walletAddress, profile.role, now, expiresAt],
  );
}

export async function findSessionById(pool: Pool, sessionId: string): Promise<UserSession | null> {
  const result = await pool.query<SessionRow>(
    `SELECT user_sessions.session_id AS "sessionId",
            user_profiles.account_id AS "accountId",
            user_sessions.user_id::text AS "userId",
            user_sessions.wallet_address AS "walletAddress",
            user_profiles.email AS "email",
            CASE
              WHEN user_profiles.break_glass_role = 'admin'
                AND user_profiles.break_glass_expires_at IS NOT NULL
                AND user_profiles.break_glass_expires_at > NOW()
                AND user_profiles.break_glass_revoked_at IS NULL
              THEN 'admin'
              ELSE user_profiles.role
            END AS role,
            user_sessions.role AS "issuedRole",
            user_profiles.active AS active,
            issued_at AS "issuedAt", expires_at AS "expiresAt",
            revoked_at AS "revokedAt"
     FROM user_sessions
     JOIN user_profiles ON user_profiles.id = user_sessions.user_id
     WHERE user_sessions.session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? normalizeSessionRow(row) : null;
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`UPDATE user_sessions SET revoked_at = $1 WHERE session_id = $2`, [
    Math.floor(Date.now() / 1000),
    sessionId,
  ]);
}

export async function pruneExpiredSessions(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM user_sessions WHERE expires_at <= $1`, [
    Math.floor(Date.now() / 1000),
  ]);
}
