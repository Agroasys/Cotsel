/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { UserProfile, UserSession } from '../../types';
import { normalizeSessionRow, SessionRow } from './sessionNormalization';

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
            user_profiles.break_glass_role AS "breakGlassRole",
            user_profiles.break_glass_expires_at AS "breakGlassExpiresAt",
            user_profiles.break_glass_granted_at AS "breakGlassGrantedAt",
            user_profiles.break_glass_granted_by AS "breakGlassGrantedBy",
            user_profiles.break_glass_reason AS "breakGlassReason",
            user_profiles.break_glass_revoked_at AS "breakGlassRevokedAt",
            user_profiles.break_glass_revoked_by AS "breakGlassRevokedBy",
            user_profiles.break_glass_reviewed_at AS "breakGlassReviewedAt",
            user_profiles.break_glass_reviewed_by AS "breakGlassReviewedBy",
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
