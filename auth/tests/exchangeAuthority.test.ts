/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  authorizeExchange,
  createExchangeAuthorityLookup,
  ExchangeAuthority,
  ExchangeAuthorityError,
  parseExchangeKeyPolicies,
} from '../src/core/exchangeAuthority';
import { UserProfile, UserRole } from '../src/types';

const MEMBER_KEY: ExchangeAuthority = {
  keyId: 'member-exchange',
  roles: ['buyer', 'supplier'],
  orgId: null,
};
const OPERATOR_KEY: ExchangeAuthority = {
  keyId: 'operator-exchange',
  roles: ['admin'],
  orgId: null,
};
const PINNED_KEY: ExchangeAuthority = {
  keyId: 'pinned-exchange',
  roles: ['buyer', 'supplier', 'admin'],
  orgId: 'org-a',
};

function profile(
  baseRole: UserRole,
  options: { breakGlassAdmin?: boolean; audited?: boolean; orgId?: string | null } = {},
): UserProfile {
  const { breakGlassAdmin = false, audited = baseRole === 'admin', orgId = null } = options;
  return {
    id: 'profile-1',
    accountId: 'agroasys-user:1',
    walletAddress: null,
    email: null,
    role: breakGlassAdmin ? 'admin' : baseRole,
    baseRole,
    adminProvisioned: baseRole === 'admin' && audited,
    orgId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    active: true,
    breakGlassRole: breakGlassAdmin ? 'admin' : null,
    breakGlassExpiresAt: null,
    breakGlassGrantedAt: null,
    breakGlassGrantedBy: null,
    breakGlassReason: null,
    breakGlassRevokedAt: null,
    breakGlassRevokedBy: null,
    breakGlassReviewedAt: null,
    breakGlassReviewedBy: null,
  };
}

function decide(
  authority: ExchangeAuthority,
  requestedRole: UserRole,
  target: UserProfile | null,
  extra: { requestedOrgId?: string | null; absorbed?: UserProfile } = {},
) {
  return authorizeExchange({
    authority,
    requestedRole,
    requestedOrgId: extra.requestedOrgId ?? null,
    target,
    absorbed: extra.absorbed,
  });
}

function expectRefused(attempt: () => unknown, message: string): void {
  expect(attempt).toThrow(ExchangeAuthorityError);
  expect(attempt).toThrow(message);
}

describe('authorizeExchange roles', () => {
  test.each([
    { name: 'a new member', authority: MEMBER_KEY, role: 'buyer', target: null, stored: 'buyer' },
    {
      name: 'a member changing role',
      authority: MEMBER_KEY,
      role: 'supplier',
      target: profile('buyer'),
      stored: 'supplier',
    },
    {
      name: 'an audited admin',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('admin'),
      stored: null,
    },
    {
      name: 'an active break-glass admin',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('buyer', { breakGlassAdmin: true }),
      stored: null,
    },
  ] as const)('admits $name', ({ authority, role, target, stored }) => {
    expect(decide(authority, role, target).role).toBe(stored);
  });

  test.each([
    {
      name: 'a role outside the key ceiling',
      authority: MEMBER_KEY,
      role: 'admin',
      target: profile('admin'),
      message: 'may not issue the admin role',
    },
    {
      name: 'admin for a new account',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: null,
      message: 'must be provisioned through the admin control plane',
    },
    {
      name: 'admin for an unprivileged account',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('supplier'),
      message: 'must be provisioned through the admin control plane',
    },
    {
      name: 'an admin row without audited provenance',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('admin', { audited: false }),
      message: 'must be provisioned through the admin control plane',
    },
    {
      name: 'demoting a provisioned admin',
      authority: { ...MEMBER_KEY, roles: ['buyer', 'supplier', 'admin'] },
      role: 'buyer',
      target: profile('admin'),
      message: 'cannot be changed through session exchange',
    },
    {
      name: 'a member key reaching break-glass admin',
      authority: MEMBER_KEY,
      role: 'buyer',
      target: profile('buyer', { breakGlassAdmin: true }),
      message: 'may not issue the admin role',
    },
  ] as const)('refuses $name', ({ authority, role, target, message }) => {
    expectRefused(() => decide(authority as ExchangeAuthority, role, target), message);
  });

  test('refuses to absorb a profile holding administrator authority', () => {
    expectRefused(
      () =>
        decide(OPERATOR_KEY, 'admin', profile('admin'), {
          absorbed: profile('supplier', { breakGlassAdmin: true }),
        }),
      'cannot merge a profile that holds administrator authority',
    );
  });
});

describe('authorizeExchange organizations', () => {
  test('passes the requested organization through an unbound key', () => {
    expect(decide(MEMBER_KEY, 'buyer', null, { requestedOrgId: 'org-1' }).orgId).toBe('org-1');
    expect(decide(MEMBER_KEY, 'buyer', null).orgId).toBeNull();
  });

  test('pins new and org-less member profiles to the key organization', () => {
    expect(decide(PINNED_KEY, 'buyer', null).orgId).toBe('org-a');
    expect(decide(PINNED_KEY, 'buyer', profile('buyer')).orgId).toBe('org-a');
    expect(decide(PINNED_KEY, 'buyer', profile('buyer', { orgId: 'org-a' })).orgId).toBe('org-a');
  });

  test('leaves an audited admin organization untouched', () => {
    expect(decide(PINNED_KEY, 'admin', profile('admin', { orgId: 'org-a' }))).toEqual({
      role: null,
      orgId: null,
    });
  });

  test.each([
    {
      name: 'a request naming another organization',
      target: profile('buyer', { orgId: 'org-a' }),
      role: 'buyer',
      requestedOrgId: 'org-b',
      message: 'not authorized for this organization',
    },
    {
      name: 'an omitted organization for another organization admin',
      target: profile('admin', { orgId: 'org-b' }),
      role: 'admin',
      requestedOrgId: null,
      message: 'not authorized for this organization',
    },
    {
      name: 'an existing member in another organization',
      target: profile('supplier', { orgId: 'org-b' }),
      role: 'supplier',
      requestedOrgId: null,
      message: 'not authorized for this organization',
    },
    {
      name: 'an org-less admin it would re-home',
      target: profile('admin'),
      role: 'admin',
      requestedOrgId: null,
      message: 'only through the admin control plane',
    },
  ] as const)('a pinned key refuses $name', ({ target, role, requestedOrgId, message }) => {
    expectRefused(() => decide(PINNED_KEY, role, target, { requestedOrgId }), message);
  });

  test('a pinned key refuses to absorb a legacy profile from another organization', () => {
    expectRefused(
      () =>
        decide(PINNED_KEY, 'buyer', profile('buyer', { orgId: 'org-a' }), {
          absorbed: profile('buyer', { orgId: 'org-b' }),
        }),
      'not authorized for this organization',
    );
  });

  test('an unbound key cannot move an admin to another organization', () => {
    expectRefused(
      () =>
        decide(OPERATOR_KEY, 'admin', profile('admin', { orgId: 'org-b' }), {
          requestedOrgId: 'org-c',
        }),
      'only through the admin control plane',
    );
  });
});

describe('parseExchangeKeyPolicies', () => {
  test('parses one explicit policy per key', () => {
    const policies = parseExchangeKeyPolicies(
      JSON.stringify({
        backend: { roles: ['admin'] },
        marketplace: { roles: ['buyer', 'supplier'], orgId: ' org-1 ' },
      }),
      ['backend', 'marketplace'],
    );
    expect(policies.get('backend')).toEqual({ roles: ['admin'], orgId: null });
    expect(policies.get('marketplace')).toEqual({ roles: ['buyer', 'supplier'], orgId: 'org-1' });
  });

  test.each([
    { raw: 'not json', message: 'must be valid JSON' },
    { raw: '[]', message: 'must be an object keyed by key ID' },
    {
      raw: '{"backend":{"roles":["admin"]}}',
      message: 'no policy for 1 configured exchange key(s)',
    },
    {
      raw: '{"backend":{"roles":["admin"]},"other":{"roles":["buyer"]},"ghost":{"roles":["buyer"]}}',
      message: 'ghost names no configured exchange key',
    },
    { raw: '{"backend":{"roles":[]},"other":{"roles":["buyer"]}}', message: 'non-empty list' },
    {
      raw: '{"backend":{"roles":["oracle"]},"other":{"roles":["buyer"]}}',
      message: 'non-empty list',
    },
    {
      raw: '{"backend":{"roles":["admin","admin"]},"other":{"roles":["buyer"]}}',
      message: 'distinct roles',
    },
    {
      raw: '{"backend":{"roles":["admin"],"capabilities":["*"]},"other":{"roles":["buyer"]}}',
      message: 'unknown fields: capabilities',
    },
    {
      raw: '{"backend":{"roles":["admin"],"orgId":""},"other":{"roles":["buyer"]}}',
      message: 'orgId must be a non-empty string or null',
    },
  ])('rejects $raw', ({ raw, message }) => {
    expect(() => parseExchangeKeyPolicies(raw, ['backend', 'other'])).toThrow(message);
  });
});

describe('createExchangeAuthorityLookup', () => {
  test('resolves configured keys and nothing else', () => {
    const lookup = createExchangeAuthorityLookup(
      JSON.stringify([{ id: 'backend', secret: 'secret', active: true }]),
      JSON.stringify({ backend: { roles: ['admin'] } }),
    );
    expect(lookup('backend')).toEqual({ keyId: 'backend', roles: ['admin'], orgId: null });
    expect(lookup('unknown')).toBeUndefined();
  });
});
