/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { UserProfile, UserSession } from '../../types';
import { normalizeSessionRow, SessionRow } from './sessionNormalization';

export interface SessionInsert {
  tokenHash: string;
  parentTokenHash: string | null;
  issuedAt: number;
  expiresAt: number;
  lineageStartedAt: number;
}

export async function insertSession(
  client: Pool | PoolClient,
  profile: UserProfile,
  session: SessionInsert,
): Promise<void> {
  await client.query(
    `INSERT INTO user_sessions (
       session_token_hash, parent_session_token_hash, user_id, wallet_address, role,
       issued_at, expires_at, lineage_started_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      session.tokenHash,
      session.parentTokenHash,
      profile.id,
      profile.walletAddress,
      profile.role,
      session.issuedAt,
      session.expiresAt,
      session.lineageStartedAt,
    ],
  );
}

export async function findSessionByTokenHash(
  pool: Pool,
  tokenHash: string,
): Promise<UserSession | null> {
  const result = await pool.query<SessionRow>(
    `SELECT user_sessions.session_token_hash AS "sessionId",
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
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'bindingId', binding.id::text,
                    'walletAddress', binding.wallet_address,
                    'actionClass', binding.action_class,
                    'environment', binding.environment,
                    'approvedAt', binding.approved_at,
                    'approvedBy', binding.approved_by_principal,
                    'ticketRef', binding.approval_ticket,
                    'notes', binding.notes
                  )
                  ORDER BY binding.approved_at ASC, binding.id ASC
                )
                FROM operator_signer_bindings AS binding
                WHERE binding.account_id = user_profiles.account_id
                  AND binding.active = TRUE
                  AND binding.state = 'active'
                  AND binding.revoked_at IS NULL
                  AND binding.approved_by_principal IS NOT NULL
                  AND binding.approved_digest = binding.evidence_digest
                  AND binding.approved_at <= NOW()
              ),
              '[]'::json
            ) AS "signerAuthorizations",
            issued_at AS "issuedAt", expires_at AS "expiresAt",
            revoked_at AS "revokedAt"
     FROM user_sessions
     JOIN user_profiles ON user_profiles.id = user_sessions.user_id
     WHERE user_sessions.session_token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? normalizeSessionRow(row) : null;
}

export async function revokeSessionByTokenHash(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query(
    `UPDATE user_sessions SET revoked_at = $1
     WHERE session_token_hash = $2 AND revoked_at IS NULL`,
    [Math.floor(Date.now() / 1000), tokenHash],
  );
}

export interface SessionRotation {
  parentTokenHash: string;
  successorTokenHash: string;
  /** Read only once the parent row lock is held; see {@link rotateSession}. */
  clock: () => number;
  ttlSeconds: number;
  absoluteLifetimeSeconds: number;
}

export type SessionRotationOutcome =
  | { status: 'rotated'; expiresAt: number }
  | { status: 'unavailable' }
  | { status: 'lifetime_exhausted' };

/**
 * Revokes the parent session and inserts its single successor in one
 * transaction. The parent row lock serialises concurrent refreshes so exactly
 * one caller observes an unrevoked parent; the unique parent index is the
 * storage backstop. The successor never outlives the lineage's absolute bound.
 *
 * The clock is read after the lock is acquired: a refresh that waited on the
 * pool or on a concurrent holder must not validate expiry, or stamp the
 * successor, with a time sampled before the wait.
 */
export async function rotateSession(
  pool: Pool,
  profile: UserProfile,
  rotation: SessionRotation,
): Promise<SessionRotationOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const parent = await client.query<{
      lineageStartedAt: number | string;
      expiresAt: number | string;
    }>(
      `SELECT lineage_started_at AS "lineageStartedAt", expires_at AS "expiresAt"
       FROM user_sessions
       WHERE session_token_hash = $1
         AND user_id = $2
         AND revoked_at IS NULL
       FOR UPDATE`,
      [rotation.parentTokenHash, profile.id],
    );
    const row = parent.rows[0];
    const now = rotation.clock();
    if (!row || Number(row.expiresAt) <= now) {
      await client.query('ROLLBACK');
      return { status: 'unavailable' };
    }

    const lineageStartedAt = Number(row.lineageStartedAt);
    const expiresAt = Math.min(
      now + rotation.ttlSeconds,
      lineageStartedAt + rotation.absoluteLifetimeSeconds,
    );

    if (expiresAt <= now) {
      await client.query('ROLLBACK');
      return { status: 'lifetime_exhausted' };
    }

    await client.query(`UPDATE user_sessions SET revoked_at = $1 WHERE session_token_hash = $2`, [
      now,
      rotation.parentTokenHash,
    ]);
    await insertSession(client, profile, {
      tokenHash: rotation.successorTokenHash,
      parentTokenHash: rotation.parentTokenHash,
      issuedAt: now,
      expiresAt,
      lineageStartedAt,
    });
    await client.query('COMMIT');
    return { status: 'rotated', expiresAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      return { status: 'unavailable' };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneExpiredSessions(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM user_sessions WHERE expires_at <= $1`, [
    Math.floor(Date.now() / 1000),
  ]);
}
