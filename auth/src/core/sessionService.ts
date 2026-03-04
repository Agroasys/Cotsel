/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { UserRole, UserSession, SessionIssueResult } from '../types';
import { ProfileStore } from './profileStore';
import { SessionStore } from './sessionStore';
import {
  incrementSessionIssued,
  incrementSessionRefreshed,
  incrementSessionRevoked,
} from '../metrics/counters';
import { Logger } from '../utils/logger';

export interface SessionService {
  /**
   * Called after Web3Auth signer is resolved on the client.
   * Upserts the UserProfile (idempotent) and issues a fresh session.
   */
  login(walletAddress: string, role: UserRole, orgId?: string, ttlSeconds?: number): Promise<SessionIssueResult>;

  /**
   * Issues a new session in exchange for a valid, non-expired, non-revoked one.
   * The old session is revoked atomically.
   */
  refresh(sessionId: string, ttlSeconds?: number): Promise<SessionIssueResult>;

  /**
   * Permanently revokes a session so it cannot be refreshed or resolved.
   */
  revoke(sessionId: string): Promise<void>;

  /**
   * Resolves a sessionId to its full UserSession, or null if invalid/expired/revoked.
   */
  resolve(sessionId: string): Promise<UserSession | null>;
}

export function createSessionService(
  sessions: SessionStore,
  profiles: ProfileStore,
): SessionService {
  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  async function resolveActive(sessionId: string): Promise<UserSession | null> {
    const session = await sessions.lookup(sessionId);
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= nowSeconds()) return null;
    return session;
  }

  return {
    async login(walletAddress, role, orgId, ttlSeconds = 3600) {
      const normalized = walletAddress.toLowerCase();
      const profile = await profiles.upsert(normalized, role, orgId);
      if (!profile.active) {
        throw new Error('User profile is deactivated');
      }
      const result = await sessions.issue(profile, ttlSeconds);
      incrementSessionIssued();
      Logger.info('Session issued', { userId: profile.id, walletAddress: profile.walletAddress, role });
      return result;
    },

    async refresh(sessionId, ttlSeconds = 3600) {
      const existing = await resolveActive(sessionId);
      if (!existing) {
        throw new Error('Session is invalid, expired, or revoked');
      }
      const profile = await profiles.findById(existing.userId);
      if (!profile || !profile.active) {
        throw new Error('User profile is inactive or not found');
      }
      await sessions.revoke(sessionId);
      const result = await sessions.issue(profile, ttlSeconds);
      incrementSessionRefreshed();
      Logger.info('Session refreshed', { userId: profile.id, walletAddress: profile.walletAddress });
      return result;
    },

    async revoke(sessionId) {
      await sessions.revoke(sessionId);
      incrementSessionRevoked();
      Logger.info('Session revoked', { sessionId });
    },

    async resolve(sessionId) {
      return resolveActive(sessionId);
    },
  };
}
