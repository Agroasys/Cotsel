/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import {
  normalizeSessionRow,
  provisionOperatorSignerBinding,
  upsertTrustedProfile,
} from '../src/database/queries';
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
      capabilities: null,
      signerAuthorizations: null,
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
        capabilities: null,
        signerAuthorizations: null,
        issuedAt: 'not-a-number',
        expiresAt: '1772920544',
        revokedAt: null,
      }),
    ).toThrow('Invalid issuedAt session timestamp returned from database');
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

describe('provisionOperatorSignerBinding', () => {
  test('rejects signer bindings for non-durable-admin profiles before any binding write occurs', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [buildProfile({ role: 'buyer', baseRole: 'buyer' })],
      })
      .mockResolvedValueOnce({});
    const pool = buildMockPool(query);

    await expect(
      provisionOperatorSignerBinding(pool, {
        accountId: 'acct-1',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        actionClass: 'governance',
        environment: 'staging-e2e-real',
        actor: { type: 'service_auth', id: 'ops-admin-control' },
        reason: 'SEC-1201 reject signer binding for non-admin profile',
        ticketRef: 'SEC-1201',
      }),
    ).rejects.toThrow('Signer bindings require a durable admin profile');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  test('returns the existing active binding deterministically without creating a duplicate row', async () => {
    const existingCreatedAt = new Date('2026-04-21T00:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [buildProfile()],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'binding-1',
            createdAt: existingCreatedAt,
            provisionedBy: 'ops-admin-control',
            provisionTicketRef: 'SEC-100',
            notes: 'approved signer binding',
          },
        ],
      })
      .mockResolvedValueOnce({});
    const pool = buildMockPool(query);

    const binding = await provisionOperatorSignerBinding(pool, {
      accountId: 'acct-1',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      actionClass: 'governance',
      environment: 'staging-e2e-real',
      actor: { type: 'service_auth', id: 'ops-admin-control' },
      reason: 'SEC-100 provision governance signer',
      ticketRef: 'SEC-100',
      notes: 'approved signer binding',
    });

    expect(binding).toEqual({
      bindingId: 'binding-1',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      actionClass: 'governance',
      environment: 'staging-e2e-real',
      approvedAt: existingCreatedAt.toISOString(),
      approvedBy: 'ops-admin-control',
      ticketRef: 'SEC-100',
      notes: 'approved signer binding',
    });
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('FROM operator_signer_bindings'),
      ['acct-1', '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'governance', 'staging-e2e-real'],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });
});
