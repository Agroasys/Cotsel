/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { Pool } from 'pg';
import { UserSession, UserProfile, SessionIssueResult, SessionLifetimePolicy } from '../types';
import {
  insertSession,
  findSessionByTokenHash,
  revokeSessionByTokenHash,
  rotateSession,
  pruneExpiredSessions,
} from '../database/queries';

export type SessionRotationResult =
  | { status: 'rotated'; session: SessionIssueResult }
  | { status: 'unavailable' }
  | { status: 'lifetime_exhausted' };

export interface SessionStore {
  issue(profile: UserProfile, ttlSeconds: number): Promise<SessionIssueResult>;
  /**
   * Atomically revokes `sessionToken` and issues its single successor, bounded by
   * the lineage's absolute lifetime.
   */
  rotate(
    sessionToken: string,
    profile: UserProfile,
    policy: SessionLifetimePolicy,
  ): Promise<SessionRotationResult>;
  lookup(sessionToken: string): Promise<UserSession | null>;
  revoke(sessionToken: string): Promise<void>;
  pruneExpired(): Promise<void>;
}

/**
 * Bearer tokens are never persisted. Only this verifier is stored, so a
 * database export cannot be replayed as a session.
 */
export function hashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken, 'utf8').digest('hex');
}

function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createPostgresSessionStore(pool: Pool): SessionStore {
  return {
    async issue(profile, ttlSeconds) {
      const sessionId = newSessionToken();
      const issuedAt = nowSeconds();
      const expiresAt = issuedAt + ttlSeconds;
      await insertSession(pool, profile, {
        tokenHash: hashSessionToken(sessionId),
        parentTokenHash: null,
        issuedAt,
        expiresAt,
        lineageStartedAt: issuedAt,
      });
      return { sessionId, expiresAt };
    },
    async rotate(sessionToken, profile, policy) {
      const sessionId = newSessionToken();
      const outcome = await rotateSession(pool, profile, {
        parentTokenHash: hashSessionToken(sessionToken),
        successorTokenHash: hashSessionToken(sessionId),
        now: nowSeconds(),
        ttlSeconds: policy.ttlSeconds,
        absoluteLifetimeSeconds: policy.absoluteLifetimeSeconds,
      });
      if (outcome.status !== 'rotated') {
        return outcome;
      }
      return { status: 'rotated', session: { sessionId, expiresAt: outcome.expiresAt } };
    },
    async lookup(sessionToken) {
      const session = await findSessionByTokenHash(pool, hashSessionToken(sessionToken));
      // The row carries only the verifier; callers keep addressing the session
      // by the bearer token they presented.
      return session ? { ...session, sessionId: sessionToken } : null;
    },
    revoke(sessionToken) {
      return revokeSessionByTokenHash(pool, hashSessionToken(sessionToken));
    },
    pruneExpired() {
      return pruneExpiredSessions(pool);
    },
  };
}
