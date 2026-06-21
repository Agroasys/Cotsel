/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { normalizeSessionRow, upsertTrustedProfile } from '../src/database/queries';
import { UserProfile } from '../src/types';

function buildProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'profile-1',
    accountId: 'acct-1',
    walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    email: 'ops@example.com',
    role: 'admin',
    baseRole: 'admin',
    orgId: 'org-1',
    createdAt: new Date('2026-04-05T00:00:00.000Z'),
    updatedAt: new Date('2026-04-05T00:00:00.000Z'),
    active: true,
    breakGlassRole: null,
    breakGlassExpiresAt: null,
    breakGlassGrantedAt: null,
    breakGlassGrantedBy: null,
    breakGlassReason: null,
    breakGlassRevokedAt: null,
    breakGlassRevokedBy: null,
    breakGlassReviewedAt: null,
    breakGlassReviewedBy: null,
    ...overrides,
  };
}

function buildMockPool(query: jest.Mock): Pool {
  return {
    connect: jest.fn().mockResolvedValue({
      query,
      release: jest.fn(),
    } satisfies Partial<PoolClient>),
  } as unknown as Pool;
}

describe('normalizeSessionRow', () => {
  test('converts bigint-backed timestamp strings to numbers', () => {
    const session = normalizeSessionRow({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      userId: 'user-1',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      email: 'ops@example.com',
      role: 'admin',
      issuedAt: '1772916944',
      expiresAt: '1772920544',
      revokedAt: null,
    });

    expect(session.accountId).toBe('acct-1');
    expect(session.email).toBe('ops@example.com');
    expect(session.issuedAt).toBe(1772916944);
    expect(session.expiresAt).toBe(1772920544);
    expect(session.revokedAt).toBeNull();
  });

  test('throws on invalid timestamp payloads', () => {
    expect(() =>
      normalizeSessionRow({
        sessionId: 'sess-2',
        accountId: 'acct-2',
        userId: 'user-2',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        email: null,
        role: 'admin',
        issuedAt: 'not-a-number',
        expiresAt: '1772920544',
        revokedAt: null,
      }),
    ).toThrow('Invalid issuedAt session timestamp returned from database');
  });

  test('derives break-glass post-incident review status from session rows', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const baseRow = {
      sessionId: 'sess-review',
      accountId: 'acct-review',
      userId: 'user-review',
      walletAddress: null,
      email: 'ops@example.com',
      role: 'admin' as const,
      issuedAt: '1772916944',
      expiresAt: '1772920544',
      revokedAt: null,
      breakGlassRole: 'admin' as const,
      breakGlassGrantedAt: past,
      breakGlassGrantedBy: 'incident-commander',
      breakGlassReason: 'INC-548 review status proof',
      breakGlassRevokedAt: null,
      breakGlassRevokedBy: null,
      breakGlassReviewedAt: null,
      breakGlassReviewedBy: null,
    };

    expect(
      normalizeSessionRow({
        ...baseRow,
        breakGlassExpiresAt: future,
      }).breakGlass,
    ).toEqual(expect.objectContaining({ active: true, reviewStatus: 'active_unreviewed' }));
    expect(
      normalizeSessionRow({
        ...baseRow,
        breakGlassExpiresAt: past,
      }).breakGlass,
    ).toEqual(expect.objectContaining({ active: false, reviewStatus: 'expired_unreviewed' }));
    expect(
      normalizeSessionRow({
        ...baseRow,
        breakGlassExpiresAt: future,
        breakGlassRevokedAt: past,
        breakGlassRevokedBy: 'security-owner',
      }).breakGlass,
    ).toEqual(expect.objectContaining({ active: false, reviewStatus: 'revoked_unreviewed' }));
    expect(
      normalizeSessionRow({
        ...baseRow,
        breakGlassExpiresAt: past,
        breakGlassReviewedAt: future,
        breakGlassReviewedBy: 'security-owner',
      }).breakGlass,
    ).toEqual(expect.objectContaining({ active: false, reviewStatus: 'reviewed' }));
    expect(
      normalizeSessionRow({
        ...baseRow,
        breakGlassExpiresAt: null,
        breakGlassReviewedAt: future,
        breakGlassReviewedBy: 'security-owner',
      }).breakGlass,
    ).toEqual(expect.objectContaining({ active: false, reviewStatus: 'expired_unreviewed' }));
  });
});

describe('upsertTrustedProfile', () => {
  test('relinks a legacy wallet-only profile to the canonical account identity', async () => {
    const relinkedProfile = buildProfile({
      id: 'profile-legacy',
      accountId: 'acct-canonical',
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          buildProfile({ id: 'profile-legacy', accountId: 'f62ccf55-b3d8-4b35-a0d0-f8f1daaeb6cb' }),
        ],
      })
      .mockResolvedValueOnce({ rows: [relinkedProfile] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = buildMockPool(query);

    const profile = await upsertTrustedProfile(pool, {
      accountId: 'acct-canonical',
      role: 'admin',
      orgId: 'org-1',
      email: 'ops@example.com',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(profile).toEqual(relinkedProfile);
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining('UPDATE user_profiles'), [
      'profile-legacy',
      'acct-canonical',
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'ops@example.com',
      'admin',
      'org-1',
    ]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  test('merges a legacy wallet profile into the canonical account profile and reassigns sessions', async () => {
    const accountProfile = buildProfile({
      id: 'profile-canonical',
      accountId: 'acct-canonical',
      walletAddress: null,
      email: 'ops@example.com',
    });
    const legacyWalletProfile = buildProfile({
      id: 'profile-legacy',
      accountId: 'f62ccf55-b3d8-4b35-a0d0-f8f1daaeb6cb',
    });
    const mergedProfile = buildProfile({
      id: 'profile-canonical',
      accountId: 'acct-canonical',
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [accountProfile] })
      .mockResolvedValueOnce({ rows: [legacyWalletProfile] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [mergedProfile] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = buildMockPool(query);

    const profile = await upsertTrustedProfile(pool, {
      accountId: 'acct-canonical',
      role: 'admin',
      orgId: 'org-1',
      email: 'ops@example.com',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(profile).toEqual(mergedProfile);
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining('UPDATE user_sessions'), [
      'profile-canonical',
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'profile-legacy',
    ]);
    expect(query).toHaveBeenNthCalledWith(5, expect.stringContaining('DELETE FROM user_profiles'), [
      'profile-legacy',
    ]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  test('rejects a trusted session wallet already linked to a different non-legacy account', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildProfile({ id: 'profile-other', accountId: 'acct-other' })],
      })
      .mockResolvedValueOnce({ rows: [] });
    const pool = buildMockPool(query);

    await expect(
      upsertTrustedProfile(pool, {
        accountId: 'acct-canonical',
        role: 'admin',
        orgId: 'org-1',
        email: 'ops@example.com',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
    ).rejects.toThrow('walletAddress is already linked to a different account');

    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
