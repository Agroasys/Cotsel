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

//  Profile queries

export async function upsertProfile(
  pool: Pool,
  walletAddress: string,
  role: UserRole,
  orgId: string | null,
): Promise<UserProfile> {
  const result = await pool.query<UserProfile>(
    `INSERT INTO user_profiles (wallet_address, role, org_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wallet_address)
     DO UPDATE SET role = EXCLUDED.role,
                   org_id = COALESCE(EXCLUDED.org_id, user_profiles.org_id),
                   updated_at = NOW()
     RETURNING id, wallet_address AS "walletAddress", role, org_id AS "orgId",
               created_at AS "createdAt", updated_at AS "updatedAt", active`,
    [walletAddress, role, orgId],
  );
  return result.rows[0];
}

export async function findProfileByWallet(
  pool: Pool,
  walletAddress: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT id, wallet_address AS "walletAddress", role, org_id AS "orgId",
            created_at AS "createdAt", updated_at AS "updatedAt", active
     FROM user_profiles WHERE wallet_address = $1`,
    [walletAddress],
  );
  return result.rows[0] ?? null;
}

export async function findProfileById(
  pool: Pool,
  id: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT id, wallet_address AS "walletAddress", role, org_id AS "orgId",
            created_at AS "createdAt", updated_at AS "updatedAt", active
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
    `SELECT session_id AS "sessionId", user_id AS "userId",
            wallet_address AS "walletAddress", role,
            issued_at AS "issuedAt", expires_at AS "expiresAt",
            revoked_at AS "revokedAt"
     FROM user_sessions WHERE session_id = $1`,
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
