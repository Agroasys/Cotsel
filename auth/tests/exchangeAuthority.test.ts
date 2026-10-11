/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  authorizeExchangeRole,
  createExchangeAuthorityLookup,
  ExchangeAuthority,
  ExchangeAuthorityError,
  parseExchangeKeyPolicies,
  resolveExchangeOrgId,
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

function profile(baseRole: UserRole, breakGlassAdmin = false): UserProfile {
  return {
    id: 'profile-1',
    accountId: 'agroasys-user:1',
    walletAddress: null,
    email: null,
    role: breakGlassAdmin ? 'admin' : baseRole,
    baseRole,
    orgId: null,
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

describe('authorizeExchangeRole', () => {
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
      name: 'a provisioned admin',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('admin'),
      stored: null,
    },
    {
      name: 'an active break-glass admin',
      authority: OPERATOR_KEY,
      role: 'admin',
      target: profile('buyer', true),
      stored: null,
    },
  ] as const)('admits $name', ({ authority, role, target, stored }) => {
    expect(authorizeExchangeRole({ authority, requestedRole: role, target })).toBe(stored);
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
      target: profile('buyer', true),
      message: 'may not issue the admin role',
    },
  ] as const)('refuses $name', ({ authority, role, target, message }) => {
    const attempt = () =>
      authorizeExchangeRole({
        authority: authority as ExchangeAuthority,
        requestedRole: role,
        target,
      });
    expect(attempt).toThrow(ExchangeAuthorityError);
    expect(attempt).toThrow(message);
  });

  test('refuses to absorb a profile holding administrator authority', () => {
    expect(() =>
      authorizeExchangeRole({
        authority: OPERATOR_KEY,
        requestedRole: 'admin',
        target: profile('admin'),
        absorbed: profile('supplier', true),
      }),
    ).toThrow('cannot merge a profile that holds administrator authority');
  });
});

describe('resolveExchangeOrgId', () => {
  test('passes the asserted organization through an unbound key', () => {
    expect(resolveExchangeOrgId(MEMBER_KEY, 'org-1')).toBe('org-1');
    expect(resolveExchangeOrgId(MEMBER_KEY, null)).toBeNull();
  });

  test('pins a bound key to its organization', () => {
    const bound = { ...MEMBER_KEY, orgId: 'org-1' };
    expect(resolveExchangeOrgId(bound, null)).toBe('org-1');
    expect(resolveExchangeOrgId(bound, 'org-1')).toBe('org-1');
    expect(() => resolveExchangeOrgId(bound, 'org-2')).toThrow(ExchangeAuthorityError);
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
    { raw: '{"backend":{"roles":["admin"]}}', message: 'no policy for exchange key(s): other' },
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
