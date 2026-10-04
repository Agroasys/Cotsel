import { HttpError } from '@agroasys/shared-http';
import { resolveTenant, type TenantAuthenticatedRequest } from '../src/auth/tenantBinding';

const delegating = { authEnabled: true, delegationApiKeyIds: ['cotsel-gateway'] };

function requestAs(apiKeyId?: string): TenantAuthenticatedRequest {
  return { serviceAuth: apiKeyId ? { apiKeyId } : undefined } as TenantAuthenticatedRequest;
}

function failure(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error('expected rejection');
}

describe('ricardian tenant binding', () => {
  test('defaults to the authenticated principal', () => {
    expect(resolveTenant(requestAs('other-service'), undefined, delegating)).toBe('other-service');
    expect(resolveTenant(requestAs('other-service'), 'other-service', delegating)).toBe(
      'other-service',
    );
  });

  test('lets only a delegating caller name another tenant', () => {
    expect(resolveTenant(requestAs('cotsel-gateway'), 'platform-a', delegating)).toBe('platform-a');

    const mismatch = failure(() =>
      resolveTenant(requestAs('other-service'), 'platform-a', delegating),
    );
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.code).toBe('TenantMismatch');
  });

  test('grants nothing when no caller is delegated', () => {
    const mismatch = failure(() =>
      resolveTenant(requestAs('cotsel-gateway'), 'platform-a', {
        authEnabled: true,
        delegationApiKeyIds: [],
      }),
    );
    expect(mismatch.statusCode).toBe(403);
  });

  test('requires an authenticated principal when auth is enabled', () => {
    const unauthenticated = failure(() => resolveTenant(requestAs(), 'platform-a', delegating));
    expect(unauthenticated.statusCode).toBe(401);
  });

  test.each([['platform main'], [''], [['platform-a', 'platform-b']], [42]])(
    'rejects a malformed tenant %p before any authorization decision',
    (claimed) => {
      expect(
        failure(() => resolveTenant(requestAs('cotsel-gateway'), claimed, delegating)).statusCode,
      ).toBe(400);
    },
  );

  test('requires an explicit tenant while auth is disabled for local runs', () => {
    const local = { authEnabled: false, delegationApiKeyIds: [] };
    expect(resolveTenant(requestAs(), 'platform-a', local)).toBe('platform-a');
    expect(failure(() => resolveTenant(requestAs(), undefined, local)).statusCode).toBe(400);
  });
});
