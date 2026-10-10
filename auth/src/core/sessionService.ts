/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  TrustedSessionIdentity,
  UserRole,
  UserSession,
  SessionIssueResult,
  SessionLifetimePolicy,
} from '../types';
import { ProfileStore } from './profileStore';
import { SessionStore } from './sessionStore';
import {
  incrementSessionIssued,
  incrementSessionRefreshed,
  incrementSessionRevoked,
  incrementAdminBreakGlassExpired,
} from '../metrics/counters';
import { Logger } from '../utils/logger';

export interface SessionService {
  /**
   * Upserts a non-privileged wallet identity and issues a fresh session.
   * Public wallet proof collection is not exposed by this service.
   */
  login(
    walletAddress: string,
    role: UserRole,
    orgId?: string,
    ttlSeconds?: number,
  ): Promise<SessionIssueResult>;

  /**
   * Issues a session for a trusted upstream account identity.
   */
  issueTrustedSession(
    identity: TrustedSessionIdentity,
    ttlSeconds?: number,
  ): Promise<SessionIssueResult>;

  /**
   * Issues the single successor of a valid, non-expired, non-revoked session and
   * revokes it in the same transaction. The successor never outlives the
   * lineage's absolute lifetime.
   */
  refresh(sessionId: string): Promise<SessionIssueResult>;

  /**
   * Permanently revokes a session so it cannot be refreshed or resolved.
   */
  revoke(sessionId: string): Promise<void>;

  /**
   * Resolves a sessionId to its full UserSession, or null if invalid/expired/revoked.
   */
  resolve(sessionId: string): Promise<UserSession | null>;
}

export function assertSessionLifetimePolicy(policy: SessionLifetimePolicy): void {
  if (!Number.isSafeInteger(policy.ttlSeconds) || policy.ttlSeconds <= 0) {
    throw new Error('Session ttlSeconds must be a positive integer');
  }
  if (
    !Number.isSafeInteger(policy.absoluteLifetimeSeconds) ||
    policy.absoluteLifetimeSeconds < policy.ttlSeconds
  ) {
    throw new Error('Session absoluteLifetimeSeconds must be an integer >= ttlSeconds');
  }
}

export function createSessionService(
  sessions: SessionStore,
  profiles: ProfileStore,
  lifetime: SessionLifetimePolicy,
): SessionService {
  assertSessionLifetimePolicy(lifetime);

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  function resolveTtl(requested: number | undefined): number {
    if (requested === undefined) {
      return lifetime.ttlSeconds;
    }
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > lifetime.ttlSeconds) {
      throw new Error(`ttlSeconds must be an integer between 1 and ${lifetime.ttlSeconds}`);
    }
    return requested;
  }

  async function resolveActive(sessionId: string): Promise<UserSession | null> {
    const session = await sessions.lookup(sessionId);
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= nowSeconds()) return null;
    if (session.active === false) {
      await sessions.revoke(sessionId);
      incrementSessionRevoked();
      Logger.warn('Session revoked because profile is inactive', {
        userId: session.userId,
      });
      return null;
    }
    if (session.issuedRole && session.issuedRole !== session.role) {
      if (session.issuedRole === 'admin' && session.role !== 'admin') {
        const expired = await profiles.expireBreakGlass(session.accountId);
        if (expired) {
          incrementAdminBreakGlassExpired();
          Logger.warn('Break-glass admin expired', {
            eventType: 'auth.break_glass_expired',
            userId: session.userId,
          });
        }
      }
      await sessions.revoke(sessionId);
      incrementSessionRevoked();
      Logger.warn('Session revoked because effective authority changed', {
        userId: session.userId,
        issuedRole: session.issuedRole,
        effectiveRole: session.role,
      });
      return null;
    }
    return session;
  }

  return {
    async login(walletAddress, role, orgId, ttlSeconds) {
      if (role === 'admin' || role === 'oracle') {
        throw new Error('Privileged roles must be provisioned server-side');
      }
      const ttl = resolveTtl(ttlSeconds);
      const normalized = walletAddress.toLowerCase();
      const profile = await profiles.upsert(normalized, role, orgId);
      if (!profile.active) {
        throw new Error('User profile is deactivated');
      }
      const result = await sessions.issue(profile, ttl);
      incrementSessionIssued();
      Logger.info('Session issued', {
        userId: profile.id,
        role: profile.role,
      });
      return result;
    },

    async issueTrustedSession(identity, ttlSeconds) {
      const ttl = resolveTtl(ttlSeconds);
      const profile = await profiles.upsertTrustedIdentity(identity);
      if (!profile.active) {
        throw new Error('User profile is deactivated');
      }

      const result = await sessions.issue(profile, ttl);
      incrementSessionIssued();
      Logger.info('Trusted session issued', {
        userId: profile.id,
        role: profile.role,
      });
      return result;
    },

    async refresh(sessionId) {
      const existing = await resolveActive(sessionId);
      if (!existing) {
        throw new Error('Session is invalid, expired, or revoked');
      }
      const profile = await profiles.findById(existing.userId);
      if (!profile || !profile.active) {
        throw new Error('User profile is inactive or not found');
      }

      const rotation = await sessions.rotate(sessionId, profile, lifetime);
      if (rotation.status === 'lifetime_exhausted') {
        Logger.info('Session refresh refused because lineage lifetime is exhausted', {
          userId: profile.id,
        });
        throw new Error('Session lifetime is exhausted; exchange a new session');
      }
      if (rotation.status !== 'rotated') {
        throw new Error('Session is invalid, expired, or revoked');
      }
      incrementSessionRefreshed();
      Logger.info('Session refreshed', {
        userId: profile.id,
        role: profile.role,
      });
      return rotation.session;
    },

    async revoke(sessionId) {
      await sessions.revoke(sessionId);
      incrementSessionRevoked();
      Logger.info('Session revoked');
    },

    async resolve(sessionId) {
      return resolveActive(sessionId);
    },
  };
}
