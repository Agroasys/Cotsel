/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { Pool } from 'pg';
import { UserSession, UserProfile, SessionIssueResult } from '../types';
import {
  insertSession,
  findSessionById,
  revokeSession,
  pruneExpiredSessions,
} from '../database/queries';

export interface SessionStore {
  issue(profile: UserProfile, ttlSeconds: number): Promise<SessionIssueResult>;
  lookup(sessionId: string): Promise<UserSession | null>;
  revoke(sessionId: string): Promise<void>;
  pruneExpired(): Promise<void>;
}

export function createPostgresSessionStore(pool: Pool): SessionStore {
  return {
    async issue(profile, ttlSeconds) {
      const sessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      await insertSession(pool, sessionId, profile, expiresAt);
      return { sessionId, expiresAt };
    },
    lookup(sessionId) {
      return findSessionById(pool, sessionId);
    },
    revoke(sessionId) {
      return revokeSession(pool, sessionId);
    },
    pruneExpired() {
      return pruneExpiredSessions(pool);
    },
  };
}
