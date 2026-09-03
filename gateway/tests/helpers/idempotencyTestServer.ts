/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import type { Server } from 'http';
import { createApp } from '../../src/app';
import type { GatewayConfig } from '../../src/config/env';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency';
import { createInMemoryIdempotencyStore } from '../../src/core/idempotencyStore';
import type { IdempotencyStore } from '../../src/core/idempotencyStore';
import type { GatewayPrincipal } from '../../src/middleware/auth';

const config: GatewayConfig = {
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
  usdcAddress: '0x0000000000000000000000000000000000000888',
  enableMutations: false,
  writeAllowlist: [],
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
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

export async function startIdempotencyTestServer(
  idempotencyStore: IdempotencyStore = createInMemoryIdempotencyStore(),
) {
  const router = Router();
  const mutationMiddleware = createIdempotencyMiddleware(idempotencyStore);
  let executionCount = 0;
  let failOnce = false;
  let unresolvedOutcomeOnce = false;
  let revertedOutcomeOnce = false;
  let slowMutationMs = 0;

  router.post(
    '/test-mutation',
    (req, _res, next) => {
      const actor = req.header('x-test-actor') ?? 'admin';
      const gatewayPrincipal: GatewayPrincipal = {
        sessionReference: `sess-${actor}`,
        session: {
          userId: actor === 'buyer' ? 'uid-buyer' : 'uid-admin',
          walletAddress:
            actor === 'buyer'
              ? '0x00000000000000000000000000000000000000bb'
              : '0x00000000000000000000000000000000000000aa',
          role: actor === 'buyer' ? 'buyer' : 'admin',
          capabilities: [],
          signerAuthorizations: [],
          issuedAt: 1_744_243_200,
          expiresAt: 1_744_246_800,
        },
        gatewayRoles: actor === 'buyer' ? [] : ['operator:read', 'operator:write'],
        operatorActionCapabilities: [],
        treasuryCapabilities:
          actor === 'buyer'
            ? []
            : [
                'treasury:read',
                'treasury:prepare',
                'treasury:approve',
                'treasury:execute_match',
                'treasury:close',
              ],
        writeEnabled: actor !== 'buyer',
      };
      req.gatewayPrincipal = gatewayPrincipal;
      next();
    },
    mutationMiddleware,
    (_req, res) => {
      if (slowMutationMs > 0) {
        return setTimeout(() => {
          executionCount += 1;
          res.status(202).json({ success: true, executionCount });
        }, slowMutationMs);
      }

      executionCount += 1;
      if (unresolvedOutcomeOnce) {
        unresolvedOutcomeOnce = false;
        res.status(503).json({
          success: false,
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            details: {
              outcome: 'broadcast_unknown',
              transactionHash: `0x${'a'.repeat(64)}`,
            },
          },
        });
        return;
      }
      if (revertedOutcomeOnce) {
        revertedOutcomeOnce = false;
        res.status(502).json({
          success: false,
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Gasless transaction reverted on-chain',
            details: {
              outcome: 'reverted',
              transactionHash: `0x${'b'.repeat(64)}`,
            },
          },
        });
        return;
      }
      if (failOnce) {
        failOnce = false;
        res.status(500).json({ success: false, executionCount });
        return;
      }
      res.status(202).json({ success: true, executionCount });
    },
  );

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
    getExecutionCount: () => executionCount,
    setFailOnce: () => {
      failOnce = true;
    },
    setUnresolvedOutcomeOnce: () => {
      unresolvedOutcomeOnce = true;
    },
    setRevertedOutcomeOnce: () => {
      revertedOutcomeOnce = true;
    },
    setSlowMutationMs: (ms: number) => {
      slowMutationMs = ms;
    },
  };
}
