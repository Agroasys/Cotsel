/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { UserProfile, UserRole } from '../../types';

/**
 * True when the latest audited control-plane role decision for the profile in
 * `user_profiles` granted durable admin. The admin control plane records one
 * in the same transaction as every provisioning or role change; nothing else
 * does, so an `admin` row without it has no audited provenance.
 */
export const AUDITED_ADMIN_SQL = `COALESCE((
    SELECT audit_event.new_role = 'admin'
    FROM auth_admin_audit_events AS audit_event
    WHERE audit_event.account_id = user_profiles.account_id
      AND audit_event.action IN ('profile_provisioned', 'profile_role_updated')
    ORDER BY audit_event.created_at DESC
    LIMIT 1
  ), FALSE)`;

export const USER_PROFILE_FIELDS = `
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
  CASE WHEN role = 'admin' THEN ${AUDITED_ADMIN_SQL} ELSE FALSE END AS "adminProvisioned",
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

export function isLegacyAccountIdPlaceholder(accountId: string): boolean {
  return LEGACY_ACCOUNT_ID_REGEX.test(accountId);
}

export async function findTrustedProfileByAccountId(
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

export async function findTrustedProfileByWalletAddress(
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

/** A null `role` leaves the stored base role unchanged. */
export async function updateTrustedProfileRow(
  client: PoolClient,
  profileId: string,
  input: {
    accountId: string;
    role: UserRole | null;
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
         role = COALESCE($5, user_profiles.role),
         org_id = COALESCE($6, user_profiles.org_id),
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${USER_PROFILE_FIELDS}`,
    [profileId, input.accountId, input.walletAddress, input.email, input.role, input.orgId],
  );
  return result.rows[0];
}

export async function insertTrustedProfileRow(
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

export async function queryProfileByAccountIdForUpdate(
  client: PoolClient,
  accountId: string,
): Promise<UserProfile | null> {
  return findTrustedProfileByAccountId(client, accountId);
}

export async function revokeActiveSessionsForUser(
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
