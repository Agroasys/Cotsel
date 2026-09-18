/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-16: treasury actor identity is derived from the authenticated
 * principal. A body-supplied actor is an assertion to check, not a value to
 * trust.
 */
import type { Request } from 'express';
import {
  resolveAuthenticatedActor,
  resolveOptionalAuthenticatedActor,
  type AuthenticatedRequest,
  type TreasuryAuthPrincipal,
} from '../src/core/actorIdentity';

function request(principal?: TreasuryAuthPrincipal): AuthenticatedRequest {
  return { serviceAuth: principal } as unknown as Request & {
    serviceAuth?: TreasuryAuthPrincipal;
  };
}

const authEnabled = { authEnabled: true };
const authDisabled = { authEnabled: false };
const delegating = { authEnabled: true, delegationApiKeyIds: ['treasury-gateway'] };

describe('treasury actor identity', () => {
  it('prefers the human principal an API key is bound to', () => {
    const req = request({
      apiKeyId: 'treasury-gateway',
      scheme: 'api_key',
      humanPrincipalId: 'finance.checker@agroasys',
    });

    expect(resolveAuthenticatedActor(req, undefined, authEnabled)).toBe('finance.checker@agroasys');
  });

  it('falls back to a namespaced service identity when no human is bound', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveAuthenticatedActor(req, undefined, authEnabled)).toBe('service:treasury-gateway');
  });

  it('ignores a body actor that matches the authenticated principal', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveAuthenticatedActor(req, 'service:treasury-gateway', authEnabled)).toBe(
      'service:treasury-gateway',
    );
  });

  it('denies a body actor that claims to be somebody else', () => {
    const req = request({
      apiKeyId: 'treasury-gateway',
      scheme: 'api_key',
      humanPrincipalId: 'finance.maker@agroasys',
    });

    expect(() => resolveAuthenticatedActor(req, 'finance.checker@agroasys', authEnabled)).toThrow(
      'actor does not match the authenticated principal',
    );
  });

  it('names the field it rejected so a maker-checker call site is identifiable', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(() =>
      resolveAuthenticatedActor(req, 'someone-else', { authEnabled: true, field: 'approvedBy' }),
    ).toThrow('approvedBy does not match the authenticated principal');
  });

  it('refuses to attribute a transition when no principal reached the handler', () => {
    expect(() => resolveAuthenticatedActor(request(), 'finance.maker', authEnabled)).toThrow(
      'Treasury transitions require an authenticated principal',
    );
  });

  it('requires a named actor when authentication is disabled for local development', () => {
    expect(() => resolveAuthenticatedActor(request(), undefined, authDisabled)).toThrow(
      'actor is required while service authentication is disabled',
    );
    expect(resolveAuthenticatedActor(request(), 'local-operator', authDisabled)).toBe(
      'local-operator',
    );
  });

  it('still binds an optional actor to the principal, and only omits it when unauthenticated', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveOptionalAuthenticatedActor(req, undefined, authEnabled)).toBe(
      'service:treasury-gateway',
    );
    expect(() => resolveOptionalAuthenticatedActor(req, 'forged', authEnabled)).toThrow(
      'actor does not match the authenticated principal',
    );
    expect(resolveOptionalAuthenticatedActor(request(), undefined, authDisabled)).toBeUndefined();
  });

  it('records both identities when a delegating caller names the operator it authenticated', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveAuthenticatedActor(req, 'user-42|0xabc|maker@agroasys', delegating)).toBe(
      'service:treasury-gateway::user-42|0xabc|maker@agroasys',
    );
  });

  it('keeps delegated operators distinct so two-person control still applies', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveAuthenticatedActor(req, 'user-maker', delegating)).not.toBe(
      resolveAuthenticatedActor(req, 'user-checker', delegating),
    );
  });

  it('denies delegation from a caller that is not on the delegation allowlist', () => {
    const req = request({ apiKeyId: 'treasury-reporting', scheme: 'api_key' });

    expect(() => resolveAuthenticatedActor(req, 'user-42', delegating)).toThrow(
      'actor does not match the authenticated principal',
    );
  });

  it('refuses a delegated identity too long to record', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(() => resolveAuthenticatedActor(req, 'x'.repeat(240), delegating)).toThrow(
      'too long to record as a delegated treasury actor',
    );
  });

  it('treats a blank body actor as no claim rather than as a mismatch', () => {
    const req = request({ apiKeyId: 'treasury-gateway', scheme: 'api_key' });

    expect(resolveAuthenticatedActor(req, '   ', authEnabled)).toBe('service:treasury-gateway');
  });
});
