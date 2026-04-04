/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { TrustedSessionIdentity, UserProfile, UserRole } from '../types';
import {
  upsertProfile,
  upsertTrustedProfile,
  findProfileByWallet,
  findProfileByAccountId,
  findProfileById,
  deactivateProfile,
} from '../database/queries';

export interface ProfileStore {
  upsert(walletAddress: string, role: UserRole, orgId?: string): Promise<UserProfile>;
  upsertTrustedIdentity(identity: TrustedSessionIdentity): Promise<UserProfile>;
  findByWallet(walletAddress: string): Promise<UserProfile | null>;
  findByAccountId(accountId: string): Promise<UserProfile | null>;
  findById(id: string): Promise<UserProfile | null>;
  deactivate(id: string): Promise<void>;
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
  };
}
