/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createAuthSessionClient } from '../src/core/authSessionClient';
import type { GatewayConfig } from '../src/config/env';

const baseConfig: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://auth.internal',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://indexer.internal/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://rpc.internal',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 8453,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: true,
  writeAllowlist: ['acct-admin'],
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
  buildTime: '2026-04-28T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: false,
  allowInsecureDownstreamAuth: false,
};

function buildAuthSession(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    userId: 'uid-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    email: 'admin@agroasys.example',
    role: 'admin',
    capabilities: ['treasury:read', 'treasury:prepare'],
    signerAuthorizations: [
      {
        bindingId: 'binding-1',
        walletAddress: '0x00000000000000000000000000000000000000aa',
        actionClass: 'treasury_approve',
        environment: 'production',
        approvedAt: '2026-04-28T08:00:00.000Z',
        approvedBy: 'uid-owner',
        ticketRef: 'FIN-900',
        notes: null,
      },
    ],
    issuedAt: 1777353600,
    expiresAt: 1777357200,
    ...overrides,
  };
}

describe('AuthSessionClient contract validation', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('accepts the auth session shape gateway authorization depends on', async () => {
    const session = buildAuthSession();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: session }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = createAuthSessionClient(baseConfig);
    await expect(client.resolveSession('sess-1', 'req-1')).resolves.toEqual(session);
  });

  test('fails closed when auth omits gateway-required session authority fields', async () => {
    const malformedSession = buildAuthSession({ capabilities: undefined });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: malformedSession }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = createAuthSessionClient(baseConfig);
    await expect(client.resolveSession('sess-1', 'req-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Auth service returned an invalid session payload',
    });
  });

  test('fails closed with a gateway error when auth returns invalid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{ invalid json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = createAuthSessionClient(baseConfig);
    await expect(client.resolveSession('sess-1', 'req-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Auth service returned an invalid session payload',
    });
  });

  test('fails closed when signer authorization action classes drift', async () => {
    const malformedSession = buildAuthSession({
      signerAuthorizations: [
        {
          bindingId: 'binding-1',
          walletAddress: '0x00000000000000000000000000000000000000aa',
          actionClass: 'treasury_wire_everything',
          environment: 'production',
          approvedAt: '2026-04-28T08:00:00.000Z',
          approvedBy: 'uid-owner',
          ticketRef: 'FIN-900',
          notes: null,
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: malformedSession }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = createAuthSessionClient(baseConfig);
    await expect(client.resolveSession('sess-1', 'req-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});
