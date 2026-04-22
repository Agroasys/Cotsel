/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import {
  createAuthenticationMiddleware,
  requireAuthorizedSignerBinding,
  requireGatewayRole,
  requireMutationWriteAccess,
  resolveGatewayActorKey,
} from '../src/middleware/auth';
import type { GatewayConfig } from '../src/config/env';
import type {
  AuthSession,
  AuthSessionClient,
  SignerAuthorization,
} from '../src/core/authSessionClient';

const baseConfig: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

function mockRes() {
  return {} as Response;
}

function buildSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: 'acct-admin',
    userId: 'uid-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    role: 'admin',
    capabilities: [],
    signerAuthorizations: [],
    email: 'admin@agroasys.io',
    issuedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

function buildSignerAuthorization(
  overrides: Partial<SignerAuthorization> = {},
): SignerAuthorization {
  return {
    bindingId: 'binding-1',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    actionClass: 'governance',
    environment: 'test',
    approvedAt: '2026-04-21T00:00:00.000Z',
    approvedBy: 'ops-admin-control',
    ticketRef: 'SEC-100',
    notes: null,
    ...overrides,
  };
}

describe('gateway auth middleware', () => {
  test('resolveGatewayActorKey prefers account identity over wallet identity', () => {
    expect(
      resolveGatewayActorKey({
        ...buildSession(),
        accountId: 'acct-admin',
        userId: 'uid-admin',
        walletAddress: '0xabc',
      }),
    ).toBe('account:acct-admin');
  });

  test('resolveGatewayActorKey falls back to user identity before wallet identity', () => {
    expect(
      resolveGatewayActorKey({
        ...buildSession(),
        accountId: undefined,
        userId: 'uid-admin',
        walletAddress: '0xABC',
      }),
    ).toBe('user:uid-admin');
  });

  test('resolveGatewayActorKey falls back to wallet identity only when accountId and userId are absent', () => {
    expect(
      resolveGatewayActorKey({
        ...buildSession(),
        accountId: undefined,
        userId: '   ',
        walletAddress: '0xABC',
      }),
    ).toBe('wallet:0xabc');
  });

  test('resolveGatewayActorKey throws when every supported identifier is missing', () => {
    expect(() =>
      resolveGatewayActorKey({
        ...buildSession(),
        accountId: undefined,
        userId: '   ',
        walletAddress: null,
      }),
    ).toThrow('Authenticated session is missing every supported actor identifier');
  });

  test('rejects missing bearer token', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn(),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, baseConfig);
    const req = {
      headers: {},
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'AUTH_REQUIRED' }),
    );
  });

  test('maps admin session to gateway write role and allowlist', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn().mockResolvedValue({
        ...buildSession(),
        walletAddress: '0xabc',
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
        ...buildSession(),
        walletAddress: '0xabc',
      }),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, {
      ...baseConfig,
      writeAllowlist: [],
    });
    const req = {
      headers: { authorization: 'Bearer sess-1' },
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(req.gatewayPrincipal?.writeEnabled).toBe(false);
  });

  test('matches allowlist entries by accountId when present', async () => {
    const client: AuthSessionClient = {
      resolveSession: jest.fn().mockResolvedValue({
        ...buildSession(),
        walletAddress: '0xabc',
      }),
      checkReadiness: jest.fn(),
    };
    const middleware = createAuthenticationMiddleware(client, {
      ...baseConfig,
      writeAllowlist: ['acct-admin'],
    });
    const req = {
      headers: { authorization: 'Bearer sess-1' },
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: Date.now() },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await middleware(req, mockRes(), next);

    expect(req.gatewayPrincipal?.writeEnabled).toBe(true);
  });
});

describe('gateway role guards', () => {
  test('requireGatewayRole rejects missing role', () => {
    const middleware = requireGatewayRole('operator:write');
    const req = {
      gatewayPrincipal: {
        session: {
          accountId: 'acct-1',
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'buyer',
          capabilities: [],
          signerAuthorizations: [],
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read'],
        operatorActionCapabilities: [],
        treasuryCapabilities: [],
        writeEnabled: false,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }),
    );
  });

  test('requireMutationWriteAccess blocks disabled writes', () => {
    const middleware = requireMutationWriteAccess();
    const req = {
      gatewayPrincipal: {
        session: {
          accountId: 'acct-1',
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'admin',
          capabilities: ['governance:write'],
          signerAuthorizations: [],
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read', 'operator:write'],
        operatorActionCapabilities: ['governance:write'],
        treasuryCapabilities: ['treasury:read'],
        writeEnabled: false,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }),
    );
  });

  test('requireMutationWriteAccess allows enabled write callers', () => {
    const middleware = requireMutationWriteAccess();
    const req = {
      gatewayPrincipal: {
        session: {
          accountId: 'acct-1',
          userId: 'uid-1',
          walletAddress: '0xabc',
          role: 'admin',
          capabilities: ['governance:write'],
          signerAuthorizations: [],
          issuedAt: 1,
          expiresAt: 2,
        },
        gatewayRoles: ['operator:read', 'operator:write'],
        operatorActionCapabilities: ['governance:write'],
        treasuryCapabilities: ['treasury:read'],
        writeEnabled: true,
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe('signer authorization enforcement', () => {
  test('matches explicit signer wallet against a normalized binding in the active environment', () => {
    const binding = requireAuthorizedSignerBinding(
      {
        sessionReference: 'sha256:test',
        session: buildSession({
          signerAuthorizations: [
            buildSignerAuthorization({
              walletAddress: '0x00000000000000000000000000000000000000AA',
            }),
          ],
        }),
        gatewayRoles: ['operator:read', 'operator:write'],
        operatorActionCapabilities: ['governance:write'],
        treasuryCapabilities: [],
        writeEnabled: true,
      },
      baseConfig,
      'governance',
      '0x00000000000000000000000000000000000000AA',
      'Preparing privileged governance approval',
    );

    expect(binding.walletAddress).toBe('0x00000000000000000000000000000000000000AA');
  });

  test('rejects signer bindings scoped to the wrong environment', () => {
    expect(() =>
      requireAuthorizedSignerBinding(
        {
          sessionReference: 'sha256:test',
          session: buildSession({
            signerAuthorizations: [
              buildSignerAuthorization({
                environment: 'staging-e2e-real',
              }),
            ],
          }),
          gatewayRoles: ['operator:read', 'operator:write'],
          operatorActionCapabilities: ['governance:write'],
          treasuryCapabilities: [],
          writeEnabled: true,
        },
        baseConfig,
        'governance',
        '0x00000000000000000000000000000000000000AA',
        'Preparing privileged governance approval',
      ),
    ).toThrow('requires an approved signer wallet binding for governance in test');
  });

  test('rejects signer bindings scoped to the wrong action class', () => {
    expect(() =>
      requireAuthorizedSignerBinding(
        {
          sessionReference: 'sha256:test',
          session: buildSession({
            signerAuthorizations: [
              buildSignerAuthorization({
                actionClass: 'treasury_close',
              }),
            ],
          }),
          gatewayRoles: ['operator:read', 'operator:write'],
          operatorActionCapabilities: ['governance:write'],
          treasuryCapabilities: [],
          writeEnabled: true,
        },
        baseConfig,
        'governance',
        '0x00000000000000000000000000000000000000AA',
        'Preparing privileged governance approval',
      ),
    ).toThrow('requires an approved signer wallet binding for governance in test');
  });
});
