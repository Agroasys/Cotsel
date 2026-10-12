/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { parseServiceApiKeys } from '@agroasys/shared-auth/serviceAuth';
import { UserProfile, UserRole } from '../types';

const EXCHANGE_ROLES: readonly UserRole[] = ['buyer', 'supplier', 'admin'];
const POLICY_FIELDS = new Set(['roles', 'orgId']);

/**
 * The authority one trusted-exchange key may confer. `roles` is the ceiling on
 * the session the key can obtain; `orgId`, when set, is the only organization
 * the key may assert.
 */
export interface ExchangeKeyPolicy {
  roles: readonly UserRole[];
  orgId: string | null;
}

export interface ExchangeAuthority extends ExchangeKeyPolicy {
  keyId: string;
}

/** Refused authority. Surfaces as `403 Forbidden`. */
export class ExchangeAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeAuthorityError';
  }
}

/**
 * Parses `TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON`: an object mapping each
 * exchange key ID to `{ roles, orgId? }`. Every configured key must have exactly
 * one policy, so no key obtains authority by omission.
 */
export function parseExchangeKeyPolicies(
  raw: string,
  keyIds: readonly string[],
): Map<string, ExchangeKeyPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON must be an object keyed by key ID');
  }

  const policies = new Map<string, ExchangeKeyPolicy>();
  for (const [keyId, entry] of Object.entries(parsed)) {
    const field = `TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON.${keyId}`;
    if (!keyIds.includes(keyId)) {
      throw new Error(`${field} names no configured exchange key`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${field} must be an object`);
    }
    const unknown = Object.keys(entry).filter((name) => !POLICY_FIELDS.has(name));
    if (unknown.length > 0) {
      throw new Error(`${field} has unknown fields: ${unknown.join(', ')}`);
    }
    const { roles, orgId } = entry as { roles?: unknown; orgId?: unknown };
    if (
      !Array.isArray(roles) ||
      roles.length === 0 ||
      new Set(roles).size !== roles.length ||
      !roles.every((role) => EXCHANGE_ROLES.includes(role as UserRole))
    ) {
      throw new Error(
        `${field}.roles must be a non-empty list of distinct roles from ${EXCHANGE_ROLES.join(', ')}`,
      );
    }
    if (orgId !== undefined && orgId !== null && (typeof orgId !== 'string' || !orgId.trim())) {
      throw new Error(`${field}.orgId must be a non-empty string or null`);
    }
    policies.set(keyId, {
      roles: [...(roles as UserRole[])],
      orgId: typeof orgId === 'string' ? orgId.trim() : null,
    });
  }

  // Report a count only: key IDs come from the secret-bearing keys JSON and
  // must not reach the startup error log.
  const missing = keyIds.filter((keyId) => !policies.has(keyId)).length;
  if (missing > 0) {
    throw new Error(
      `TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON has no policy for ${missing} configured exchange key(s)`,
    );
  }
  return policies;
}

/**
 * Builds the startup-validated lookup from authenticated exchange key ID to
 * the authority that key may confer.
 */
export function createExchangeAuthorityLookup(
  rawKeys: string,
  rawPolicies: string,
): (keyId: string) => ExchangeAuthority | undefined {
  const keyIds = parseServiceApiKeys(rawKeys).map((key) => key.id);
  const policies = parseExchangeKeyPolicies(rawPolicies, keyIds);
  return (keyId) => {
    const policy = policies.get(keyId);
    return policy ? { keyId, ...policy } : undefined;
  };
}

/** Applies the key's organization binding to the organization in the request. */
function resolveRequestedOrgId(
  authority: ExchangeAuthority,
  requestedOrgId: string | null,
): string | null {
  if (authority.orgId === null) {
    return requestedOrgId;
  }
  if (requestedOrgId !== null && requestedOrgId !== authority.orgId) {
    throw new ExchangeAuthorityError('Exchange key is not authorized for this organization');
  }
  return authority.orgId;
}

/**
 * Durable administrator authority counts only when the latest audited
 * control-plane role decision granted it (`adminProvisioned`). An `admin` row
 * without that provenance, such as one written by the previous exchange,
 * confers nothing. Active break-glass elevation is itself control-plane only.
 */
export function hasAdminAuthority(profile: UserProfile): boolean {
  if (profile.role !== 'admin') {
    return false;
  }
  return profile.baseRole !== 'admin' || profile.adminProvisioned === true;
}

/**
 * Checks one existing profile the exchange would update or absorb against the
 * key's organization binding. Administrator organization changes belong to
 * the audited control plane.
 */
function assertOrganization(
  authority: ExchangeAuthority,
  profile: UserProfile,
  orgId: string | null,
): void {
  if (authority.orgId !== null && profile.orgId !== null && profile.orgId !== authority.orgId) {
    throw new ExchangeAuthorityError('Exchange key is not authorized for this organization');
  }
  if (
    (profile.baseRole === 'admin' || hasAdminAuthority(profile)) &&
    orgId !== null &&
    orgId !== profile.orgId
  ) {
    throw new ExchangeAuthorityError(
      'Administrator organization can be changed only through the admin control plane',
    );
  }
}

export interface ExchangeProfileWrite {
  /** Base role to persist, or null to leave the stored role unchanged. */
  role: UserRole | null;
  /** Organization to persist, or null to leave the stored organization unchanged. */
  orgId: string | null;
}

/**
 * Decides whether a trusted exchange may issue `requestedRole` for `target`,
 * and what it may write. The exchange never creates, widens, narrows, or
 * re-homes administrator authority: that belongs to the audited admin control
 * plane. `target` is the locked profile the exchange will update, or null when
 * it will insert one; `absorbed` is a locked legacy wallet profile it would
 * merge into `target` and delete. Call it before any write.
 */
export function authorizeExchange(input: {
  authority: ExchangeAuthority;
  requestedRole: UserRole;
  requestedOrgId: string | null;
  target: UserProfile | null;
  absorbed?: UserProfile | null;
}): ExchangeProfileWrite {
  const { authority, requestedRole, target, absorbed } = input;
  if (!authority.roles.includes(requestedRole)) {
    throw new ExchangeAuthorityError(`Exchange key may not issue the ${requestedRole} role`);
  }
  const orgId = resolveRequestedOrgId(authority, input.requestedOrgId);
  if (absorbed) {
    if (absorbed.baseRole === 'admin' || hasAdminAuthority(absorbed)) {
      throw new ExchangeAuthorityError(
        'Session exchange cannot merge a profile that holds administrator authority',
      );
    }
    assertOrganization(authority, absorbed, orgId);
  }
  if (target) {
    assertOrganization(authority, target, orgId);
  }

  if (requestedRole === 'admin') {
    if (!target || !hasAdminAuthority(target)) {
      throw new ExchangeAuthorityError(
        'Administrator authority must be provisioned through the admin control plane',
      );
    }
    return { role: null, orgId: null };
  }

  if (target?.baseRole === 'admin') {
    throw new ExchangeAuthorityError(
      'Provisioned administrator authority cannot be changed through session exchange',
    );
  }
  // Active break-glass elevation still yields an administrator session, so the
  // key must also be entitled to the role the session will actually carry.
  if (target && hasAdminAuthority(target) && !authority.roles.includes('admin')) {
    throw new ExchangeAuthorityError('Exchange key may not issue the admin role');
  }
  return { role: requestedRole, orgId };
}
