/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AdminActor, UserProfile, UserRole } from '../types';
import { ProfileStore } from './profileStore';
import {
  incrementAdminBreakGlassGranted,
  incrementAdminBreakGlassRevoked,
  incrementAdminDurableProvisioned,
  incrementAdminDurableRevoked,
} from '../metrics/counters';
import { Logger } from '../utils/logger';

interface ProvisionProfileInput {
  accountId: string;
  role: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  actor: AdminActor;
  reason: string;
}

interface GrantBreakGlassInput {
  accountId: string;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  actor: AdminActor;
  reason: string;
  ttlSeconds: number;
  baseRole?: Exclude<UserRole, 'admin'>;
}

interface AccountActionInput {
  accountId: string;
  actor: AdminActor;
  reason: string;
}

export interface AdminService {
  provisionProfile(input: ProvisionProfileInput): Promise<UserProfile>;
  grantBreakGlass(input: GrantBreakGlassInput): Promise<UserProfile>;
  revokeBreakGlass(input: AccountActionInput): Promise<UserProfile | null>;
  reviewBreakGlass(input: AccountActionInput): Promise<UserProfile>;
  deactivateProfile(input: AccountActionInput): Promise<UserProfile>;
}

function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 8) {
    throw new Error('Reason must be at least 8 characters');
  }
  if (trimmed.length > 500) {
    throw new Error('Reason must be 500 characters or fewer');
  }
  return trimmed;
}

export function createAdminService(
  profiles: ProfileStore,
  maxBreakGlassTtlSeconds: number,
): AdminService {
  return {
    async provisionProfile(input) {
      const reason = normalizeReason(input.reason);
      const previous = await profiles.findByAccountId(input.accountId);
      const profile = await profiles.provision({ ...input, reason });
      const previousWasDurableAdmin = previous?.baseRole === 'admin';
      const nowDurableAdmin = profile.baseRole === 'admin';

      if (!previousWasDurableAdmin && nowDurableAdmin) {
        incrementAdminDurableProvisioned();
      }
      if (previousWasDurableAdmin && !nowDurableAdmin) {
        incrementAdminDurableRevoked();
      }
      let eventType = 'auth.profile_role_updated';
      if (!previousWasDurableAdmin && nowDurableAdmin) {
        eventType = 'auth.durable_admin_provisioned';
      } else if (previousWasDurableAdmin && nowDurableAdmin) {
        eventType = 'auth.admin_profile_updated';
      } else if (previousWasDurableAdmin && !nowDurableAdmin) {
        eventType = 'auth.durable_admin_revoked';
      }
      Logger.info('Admin profile control updated', {
        eventType,
        actorId: input.actor.id,
        accountId: input.accountId,
        previousRole: previous?.baseRole ?? null,
        newRole: profile.baseRole,
      });
      return profile;
    },

    async grantBreakGlass(input) {
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new Error('ttlSeconds must be a positive integer');
      }
      if (input.ttlSeconds > maxBreakGlassTtlSeconds) {
        throw new Error(`ttlSeconds must be <= ${maxBreakGlassTtlSeconds}`);
      }

      const profile = await profiles.grantBreakGlass({
        ...input,
        baseRole: input.baseRole ?? 'buyer',
        reason: normalizeReason(input.reason),
      });
      incrementAdminBreakGlassGranted();
      Logger.warn('Break-glass admin granted', {
        eventType: 'auth.break_glass_granted',
        actorId: input.actor.id,
        accountId: input.accountId,
        expiresAt: profile.breakGlassExpiresAt?.toISOString() ?? null,
      });
      return profile;
    },

    async revokeBreakGlass(input) {
      const profile = await profiles.revokeBreakGlass(
        input.accountId,
        input.actor,
        normalizeReason(input.reason),
      );
      if (profile) {
        incrementAdminBreakGlassRevoked();
        Logger.warn('Break-glass admin revoked', {
          eventType: 'auth.break_glass_revoked',
          actorId: input.actor.id,
          accountId: input.accountId,
        });
      }
      return profile;
    },

    async reviewBreakGlass(input) {
      return profiles.reviewBreakGlass(input.accountId, input.actor, normalizeReason(input.reason));
    },

    async deactivateProfile(input) {
      const previous = await profiles.findByAccountId(input.accountId);
      const profile = await profiles.deactivateWithAudit(
        input.accountId,
        input.actor,
        normalizeReason(input.reason),
      );
      const revokedDurableAdmin = previous?.baseRole === 'admin' && previous.active;
      if (revokedDurableAdmin) {
        incrementAdminDurableRevoked();
      }
      Logger.warn('Admin profile deactivated', {
        eventType: revokedDurableAdmin ? 'auth.durable_admin_revoked' : 'auth.profile_deactivated',
        actorId: input.actor.id,
        accountId: input.accountId,
      });
      return profile;
    },
  };
}
