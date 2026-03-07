/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { createAuthenticationMiddleware, requireGatewayRole, requireMutationWriteAccess } from '../src/middleware/auth';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';

const baseConfig: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
};

function mockRes() {
  return {} as Response;
}

describe('gateway auth middleware', () => {
  test('rejects missing bearer token', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn(),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, baseConfig);
    const req = { headers: {}, requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() } } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'AUTH_REQUIRED' }));
  });

  test('maps admin session to gateway write role and allowlist', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn().mockResolvedValue({
        userId: 'uid-admin',
        walletAddress: '0xabc',
        role: 'admin',
        issuedAt: 1,
        expiresAt: 2,
      }),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, baseConfig);
    const req = {
      headers: { authorization: 'Bearer sess-1' },
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.gatewayPrincipal?.sessionReference).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(req.gatewayPrincipal?.sessionReference).not.toBe('sess-1');
    expect(req.gatewayPrincipal?.gatewayRoles).toEqual(['operator:read', 'operator:write']);
    expect(req.gatewayPrincipal?.writeEnabled).toBe(true);
  });

  test('disables write access when allowlist is empty', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn().mockResolvedValue({
        userId: 'uid-admin',
        walletAddress: '0xabc',
        role: 'admin',
        issuedAt: 1,
        expiresAt: 2,
      }),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, { ...baseConfig, writeAllowlist: [] });
    const req = {
      headers: { authorization: 'Bearer sess-1' },
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(req.gatewayPrincipal?.writeEnabled).toBe(false);
  });
});

describe('gateway role guards', () => {
  test('requireGatewayRole rejects missing role', () => {
    const middleware = requireGatewayRole('operator:write');
    const req = {
      gatewayPrincipal: {
        session: {
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'buyer',
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read'],
        writeEnabled: false,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
  });

  test('requireMutationWriteAccess blocks disabled writes', () => {
    const middleware = requireMutationWriteAccess();
    const req = {
      gatewayPrincipal: {
        session: {
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'admin',
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read', 'operator:write'],
        writeEnabled: false,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
  });

  test('requireMutationWriteAccess allows enabled write callers', () => {
    const middleware = requireMutationWriteAccess();
    const req = {
      gatewayPrincipal: {
        session: {
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'admin',
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read', 'operator:write'],
        writeEnabled: true,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});
