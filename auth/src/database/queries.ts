/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { UserProfile, UserSession, UserRole } from '../types';

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
  role,
  org_id AS "orgId",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  active
`;

const LEGACY_ACCOUNT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSessionEpoch(value: number | string, field: 'issuedAt' | 'expiresAt' | 'revokedAt'): number {
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
    [
      profileId,
      input.accountId,
      input.walletAddress,
      input.email,
      input.role,
      input.orgId,
    ],
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
    [
      input.accountId,
      input.walletAddress,
      input.email,
      input.role,
      input.orgId,
    ],
  );
  return result.rows[0];
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
     DO UPDATE SET role = EXCLUDED.role,
                   org_id = COALESCE(EXCLUDED.org_id, user_profiles.org_id),
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
        walletMatch.accountId !== input.accountId
        && !isLegacyAccountIdPlaceholder(walletMatch.accountId)
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

export async function findProfileById(
  pool: Pool,
  id: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function deactivateProfile(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE user_profiles SET active = FALSE, updated_at = NOW() WHERE id = $1`,
    [id],
  );
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

export async function findSessionById(
  pool: Pool,
  sessionId: string,
): Promise<UserSession | null> {
  const result = await pool.query<SessionRow>(
    `SELECT user_sessions.session_id AS "sessionId",
            user_profiles.account_id AS "accountId",
            user_sessions.user_id::text AS "userId",
            user_sessions.wallet_address AS "walletAddress",
            user_profiles.email AS "email",
            user_sessions.role AS role,
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
  await pool.query(
    `UPDATE user_sessions SET revoked_at = $1 WHERE session_id = $2`,
    [Math.floor(Date.now() / 1000), sessionId],
  );
}

export async function pruneExpiredSessions(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM user_sessions WHERE expires_at <= $1`,
    [Math.floor(Date.now() / 1000)],
  );
}
