/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { UserProfile, UserRole } from '../types';
import {
  upsertProfile,
  findProfileByWallet,
  findProfileById,
  deactivateProfile,
} from '../database/queries';

export interface ProfileStore {
  upsert(walletAddress: string, role: UserRole, orgId?: string): Promise<UserProfile>;
  findByWallet(walletAddress: string): Promise<UserProfile | null>;
  findById(id: string): Promise<UserProfile | null>;
  deactivate(id: string): Promise<void>;
}

export function createPostgresProfileStore(pool: Pool): ProfileStore {
  return {
    upsert(walletAddress, role, orgId) {
      return upsertProfile(pool, walletAddress.toLowerCase(), role, orgId ?? null);
    },
    findByWallet(walletAddress) {
      return findProfileByWallet(pool, walletAddress.toLowerCase());
    },
    findById(id) {
      return findProfileById(pool, id);
    },
    deactivate(id) {
      return deactivateProfile(pool, id);
    },
  };
}
