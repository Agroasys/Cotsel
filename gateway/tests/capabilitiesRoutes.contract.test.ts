/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createCapabilitiesRouter } from '../src/routes/capabilities';
import type {
  AuthSession,
  AuthSessionClient,
  AuthServiceRole,
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
  buildTime: '2026-03-14T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

async function startServer(
  role: AuthServiceRole | null,
  config: GatewayConfig = baseConfig,
  sessionOverrides: Omit<Partial<AuthSession>, 'walletAddress'> & {
    walletAddress?: string | null;
  } = {},
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (role === null) {
        return null;
      }

      return {
        accountId: `acct-${role}`,
        userId: `uid-${role}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role,
        capabilities:
          role === 'admin'
            ? [
                'governance:write',
                'compliance:write',
                'treasury:read',
                'treasury:prepare',
                'treasury:approve',
                'treasury:execute_match',
                'treasury:close',
              ]
            : [],
        signerAuthorizations: [],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ...sessionOverrides,
      } as AuthSession;
    }),
    checkReadiness: jest.fn(),
  };

  const router = Router();
  router.use(createCapabilitiesRouter({ authSessionClient, config }));

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
  };
}

describe('gateway capabilities route contract', () => {
  const spec = loadOpenApiSpec();
  const validateCapabilities = createSchemaValidator(
    spec,
    '#/components/schemas/OperatorCapabilitiesResponse',
  );

  test('OpenAPI spec exposes capabilities endpoint', () => {
    expect(hasOperation(spec, 'get', '/auth/capabilities')).toBe(true);
  });

  test('GET /auth/capabilities returns schema-valid admin capability snapshot', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const response = await fetch(`${baseUrl}/auth/capabilities`, {
        headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-capabilities' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-capabilities');
      expect(validateCapabilities(payload)).toBe(true);
      expect(payload.data.subject.accountId).toBe('acct-admin');
      expect(payload.data.subject.authRole).toBe('admin');
      expect(payload.data.subject.gatewayRoles).toEqual(['operator:read', 'operator:write']);
      expect(payload.data.subject.capabilities).toEqual([
        'governance:write',
        'compliance:write',
        'treasury:read',
        'treasury:prepare',
        'treasury:approve',
        'treasury:execute_match',
        'treasury:close',
      ]);
      expect(payload.data.routes.overviewRead).toBe(true);
      expect(payload.data.routes.governanceRead).toBe(true);
      expect(payload.data.actions.governanceWrite).toBe(true);
      expect(payload.data.actions.complianceWrite).toBe(true);
      expect(payload.data.actions.treasuryRead).toBe(true);
      expect(payload.data.actions.treasuryPrepare).toBe(true);
      expect(payload.data.actions.treasuryApprove).toBe(true);
      expect(payload.data.actions.treasuryExecuteMatch).toBe(true);
      expect(payload.data.actions.treasuryClose).toBe(true);
      expect(payload.data.writeAccess).toEqual({
        mutationsConfigured: true,
        allowlisted: true,
        effective: true,
      });
    } finally {
      server.close();
    }
  });

  test('GET /auth/capabilities returns explicit no-operator snapshot for buyer sessions', async () => {
    const { server, baseUrl } = await startServer('buyer');

    try {
      const response = await fetch(`${baseUrl}/auth/capabilities`, {
        headers: { Authorization: 'Bearer sess-buyer' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateCapabilities(payload)).toBe(true);
      expect(payload.data.subject.accountId).toBe('acct-buyer');
      expect(payload.data.subject.authRole).toBe('buyer');
      expect(payload.data.subject.gatewayRoles).toEqual([]);
      expect(payload.data.subject.capabilities).toEqual([]);
      expect(payload.data.routes.operationsRead).toBe(false);
      expect(payload.data.actions.governanceWrite).toBe(false);
      expect(payload.data.actions.complianceWrite).toBe(false);
      expect(payload.data.actions.treasuryRead).toBe(false);
      expect(payload.data.writeAccess).toEqual({
        mutationsConfigured: true,
        allowlisted: false,
        effective: false,
      });
    } finally {
      server.close();
    }
  });

  test('GET /auth/capabilities exposes allowlist state when mutations are disabled', async () => {
    const { server, baseUrl } = await startServer('admin', {
      ...baseConfig,
      enableMutations: false,
    });

    try {
      const response = await fetch(`${baseUrl}/auth/capabilities`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateCapabilities(payload)).toBe(true);
      expect(payload.data.actions.governanceWrite).toBe(false);
      expect(payload.data.actions.complianceWrite).toBe(false);
      expect(payload.data.actions.treasuryPrepare).toBe(false);
      expect(payload.data.writeAccess).toEqual({
        mutationsConfigured: false,
        allowlisted: true,
        effective: false,
      });
    } finally {
      server.close();
    }
  });

  test('GET /auth/capabilities allows authenticated sessions without a linked wallet', async () => {
    const { server, baseUrl } = await startServer('admin', baseConfig, { walletAddress: null });

    try {
      const response = await fetch(`${baseUrl}/auth/capabilities`, {
        headers: { Authorization: 'Bearer sess-admin-no-wallet' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateCapabilities(payload)).toBe(true);
      expect(payload.data.subject.accountId).toBe('acct-admin');
      expect(payload.data.subject.walletAddress).toBeNull();
      expect(payload.data.actions.governanceWrite).toBe(true);
    } finally {
      server.close();
    }
  });

  test('GET /auth/capabilities enforces authentication', async () => {
    const { server, baseUrl } = await startServer(null);

    try {
      const response = await fetch(`${baseUrl}/auth/capabilities`);
      expect(response.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
