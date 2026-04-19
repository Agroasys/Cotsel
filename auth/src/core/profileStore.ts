/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { AdminActor, TrustedSessionIdentity, UserProfile, UserRole } from '../types';
import {
  upsertProfile,
  upsertTrustedProfile,
  findProfileByWallet,
  findProfileByAccountId,
  findProfileById,
  deactivateProfile,
  provisionProfileWithAudit,
  grantBreakGlassAdmin,
  revokeBreakGlassAdmin,
  reviewBreakGlassAdmin,
  deactivateProfileWithAudit,
} from '../database/queries';

export interface ProfileStore {
  upsert(walletAddress: string, role: UserRole, orgId?: string): Promise<UserProfile>;
  upsertTrustedIdentity(identity: TrustedSessionIdentity): Promise<UserProfile>;
  findByWallet(walletAddress: string): Promise<UserProfile | null>;
  findByAccountId(accountId: string): Promise<UserProfile | null>;
  findById(id: string): Promise<UserProfile | null>;
  deactivate(id: string): Promise<void>;
  provision(input: {
    accountId: string;
    role: UserRole;
    orgId?: string | null;
    email?: string | null;
    walletAddress?: string | null;
    actor: AdminActor;
    reason: string;
  }): Promise<UserProfile>;
  grantBreakGlass(input: {
    accountId: string;
    baseRole: Exclude<UserRole, 'admin'>;
    orgId?: string | null;
    email?: string | null;
    walletAddress?: string | null;
    actor: AdminActor;
    reason: string;
    ttlSeconds: number;
  }): Promise<UserProfile>;
  revokeBreakGlass(
    accountId: string,
    actor: AdminActor,
    reason: string,
  ): Promise<UserProfile | null>;
  expireBreakGlass(accountId: string): Promise<UserProfile | null>;
  reviewBreakGlass(accountId: string, actor: AdminActor, reason: string): Promise<UserProfile>;
  deactivateWithAudit(accountId: string, actor: AdminActor, reason: string): Promise<UserProfile>;
}

export function createPostgresProfileStore(pool: Pool): ProfileStore {
  return {
    upsert(walletAddress, role, orgId) {
      return upsertProfile(pool, walletAddress.toLowerCase(), role, orgId ?? null);
    },
    upsertTrustedIdentity(identity) {
      return upsertTrustedProfile(pool, {
        accountId: identity.accountId,
        role: identity.role,
        orgId: identity.orgId ?? null,
        email: identity.email?.trim().toLowerCase() ?? null,
        walletAddress: identity.walletAddress?.toLowerCase() ?? null,
      });
    },
    findByWallet(walletAddress) {
      return findProfileByWallet(pool, walletAddress.toLowerCase());
    },
    findByAccountId(accountId) {
      return findProfileByAccountId(pool, accountId);
    },
    findById(id) {
      return findProfileById(pool, id);
    },
    deactivate(id) {
      return deactivateProfile(pool, id);
    },
    provision(input) {
      return provisionProfileWithAudit(pool, {
        accountId: input.accountId,
        role: input.role,
        orgId: input.orgId ?? null,
        email: input.email?.trim().toLowerCase() ?? null,
        walletAddress: input.walletAddress?.toLowerCase() ?? null,
        actor: input.actor,
        reason: input.reason,
      });
    },
    grantBreakGlass(input) {
      return grantBreakGlassAdmin(pool, {
        accountId: input.accountId,
        baseRole: input.baseRole,
        orgId: input.orgId ?? null,
        email: input.email?.trim().toLowerCase() ?? null,
        walletAddress: input.walletAddress?.toLowerCase() ?? null,
        actor: input.actor,
        reason: input.reason,
        ttlSeconds: input.ttlSeconds,
      });
    },
    revokeBreakGlass(accountId, actor, reason) {
      return revokeBreakGlassAdmin(pool, accountId, actor, reason);
    },
    expireBreakGlass(accountId) {
      return revokeBreakGlassAdmin(
        pool,
        accountId,
        { type: 'system', id: 'system:break_glass_expiry' },
        'Break-glass access expired',
        'break_glass_expired',
      );
    },
    reviewBreakGlass(accountId, actor, reason) {
      return reviewBreakGlassAdmin(pool, accountId, actor, reason);
    },
    deactivateWithAudit(accountId, actor, reason) {
      return deactivateProfileWithAudit(pool, accountId, actor, reason);
    },
  };
}
