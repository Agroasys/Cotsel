/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { UserProfile, UserRole } from '../../types';
import {
  USER_PROFILE_FIELDS,
  findTrustedProfileByAccountId,
  findTrustedProfileByWalletAddress,
  insertTrustedProfileRow,
  isLegacyAccountIdPlaceholder,
  updateTrustedProfileRow,
} from './profileRows';

export async function upsertProfile(
  pool: Pool,
  walletAddress: string,
  role: UserRole,
  orgId: string | null,
): Promise<UserProfile> {
  const result = await pool.query<UserProfile>(
    `INSERT INTO user_profiles (account_id, wallet_address, role, org_id, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())
     ON CONFLICT (wallet_address)
     DO UPDATE SET org_id = COALESCE(EXCLUDED.org_id, user_profiles.org_id),
                   updated_at = NOW()
     RETURNING ${USER_PROFILE_FIELDS}`,
    [walletAddress, role, orgId],
  );
  return result.rows[0];
}

export async function upsertTrustedProfile(
  pool: Pool,
  input: {
    accountId: string;
    role: UserRole;
    orgId: string | null;
    email: string | null;
    walletAddress: string | null;
  },
): Promise<UserProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const accountMatch = await findTrustedProfileByAccountId(client, input.accountId);
    const walletMatch = input.walletAddress
      ? await findTrustedProfileByWalletAddress(client, input.walletAddress)
      : null;

    if (accountMatch && walletMatch && accountMatch.id !== walletMatch.id) {
      if (!isLegacyAccountIdPlaceholder(walletMatch.accountId)) {
        throw new Error('walletAddress is already linked to a different account');
      }
      if (accountMatch.walletAddress && accountMatch.walletAddress !== input.walletAddress) {
        throw new Error('trusted account already has a different linked wallet');
      }

      await client.query(
        `UPDATE user_sessions
         SET user_id = $1,
             wallet_address = COALESCE($2, wallet_address)
         WHERE user_id = $3`,
        [accountMatch.id, input.walletAddress, walletMatch.id],
      );
      await client.query(`DELETE FROM user_profiles WHERE id = $1`, [walletMatch.id]);
      const mergedProfile = await updateTrustedProfileRow(client, accountMatch.id, input);
      await client.query('COMMIT');
      return mergedProfile;
    }

    if (accountMatch) {
      const updatedProfile = await updateTrustedProfileRow(client, accountMatch.id, input);
      await client.query('COMMIT');
      return updatedProfile;
    }

    if (walletMatch) {
      if (
        walletMatch.accountId !== input.accountId &&
        !isLegacyAccountIdPlaceholder(walletMatch.accountId)
      ) {
        throw new Error('walletAddress is already linked to a different account');
      }

      const relinkedProfile = await updateTrustedProfileRow(client, walletMatch.id, input);
      await client.query('COMMIT');
      return relinkedProfile;
    }

    const insertedProfile = await insertTrustedProfileRow(client, input);
    await client.query('COMMIT');
    return insertedProfile;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findProfileByWallet(
  pool: Pool,
  walletAddress: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE wallet_address = $1`,
    [walletAddress],
  );
  return result.rows[0] ?? null;
}

export async function findProfileByAccountId(
  pool: Pool,
  accountId: string,
): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function findProfileById(pool: Pool, id: string): Promise<UserProfile | null> {
  const result = await pool.query<UserProfile>(
    `SELECT ${USER_PROFILE_FIELDS}
     FROM user_profiles WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function deactivateProfile(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE user_profiles SET active = FALSE, updated_at = NOW() WHERE id = $1`, [
    id,
  ]);
}
