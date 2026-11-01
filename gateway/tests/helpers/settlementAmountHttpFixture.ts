/** SPDX-License-Identifier: Apache-2.0 */
import express, { Router } from 'express';
import { createServer, type Server } from 'http';
import type { Pool } from 'pg';
import { createPostgresNonceStore } from '@agroasys/shared-auth';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { gatewayRateLimitPolicy } from '../../src/httpSecurity';
import { createApp } from '../../src/app';
import { createPostgresIdempotencyStore } from '../../src/core/idempotencyStore';
import {
  createServiceApiKeyLookup,
  createServiceAuthHeaders,
  createServiceAuthMiddleware,
} from '../../src/core/serviceAuth';
import { SettlementService } from '../../src/core/settlementService';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { createSettlementRouter } from '../../src/routes/settlement';
import { baseTestGatewayConfig } from '../support/testConfig';

export const AMOUNT_HANDOFF_PATH = '/api/dashboard-gateway/v1/settlement/handoffs';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
  return `http://127.0.0.1:${address.port}`;
}

export async function settlementAmountHttpFixture(pool: Pool) {
  const receipts: Array<{ body: Record<string, unknown>; rawBody: string }> = [];
  const nonceStore = createPostgresNonceStore({
    tableName: 'service_auth_nonces',
    query: (sql, values) => pool.query(sql, values),
  });
  const receiver = express();
  const limiter = await createHttpRateLimiter({
    enabled: true,
    nodeEnv: 'test',
    keyPrefix: 'amount-callback-fixture',
    classifyRoute: gatewayRateLimitPolicy,
  });
  receiver.use(limiter.middleware);
  receiver.use(
    express.json({
      verify: (req, _res, body) => {
        (req as express.Request).rawBody = body;
      },
    }),
  );
  const callbackAuth = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 300,
    nonceTtlSeconds: 600,
    lookupApiKey: createServiceApiKeyLookup(
      JSON.stringify([{ id: 'callback-key', secret: 'callback-secret', active: true }]),
    ),
    consumeNonce: nonceStore.consume,
  });
  receiver.post('/callbacks', callbackAuth, (req, res) => {
    receipts.push({
      body: req.body as Record<string, unknown>,
      rawBody: req.rawBody!.toString('utf8'),
    });
    res.status(202).end();
  });
  const receiverServer = createServer(receiver);
  let gatewayServer: Server | undefined;
  async function close() {
    for (const server of [gatewayServer, receiverServer]) {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
    await limiter.close();
  }
  try {
    const callbackOrigin = await listen(receiverServer);
    const config = {
      ...baseTestGatewayConfig,
      settlementIngressEnabled: true,
      settlementServiceAuthApiKeysJson: JSON.stringify([
        { id: 'platform-main', secret: 'platform-secret', active: true },
        { id: 'platform-other', secret: 'platform-secret', active: true },
      ]),
      settlementCallbackEnabled: true,
      settlementCallbackUrl: `${callbackOrigin}/callbacks`,
      settlementCallbackApiKey: 'callback-key',
      settlementCallbackApiSecret: 'callback-secret',
    };
    const store = createPostgresSettlementStore(pool);
    const service = new SettlementService(config, store);
    const router = Router();
    router.use(
      createSettlementRouter({
        config,
        settlementService: service,
        settlementStore: store,
        nonceStore,
        idempotencyStore: createPostgresIdempotencyStore(pool),
        lookupServiceApiKey: createServiceApiKeyLookup(config.settlementServiceAuthApiKeysJson),
      }),
    );
    const app = createApp(config, {
      version: 'test',
      commitSha: config.commitSha,
      buildTime: config.buildTime,
      readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
      extraRouter: router,
    });
    gatewayServer = createServer(app);
    const gatewayOrigin = await listen(gatewayServer);
    async function post(
      rawBody: string,
      idempotencyKey: string,
      apiKey = 'platform-main',
      signedBody = rawBody,
    ) {
      return fetch(`${gatewayOrigin}${AMOUNT_HANDOFF_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          ...createServiceAuthHeaders({
            apiKey,
            apiSecret: 'platform-secret',
            method: 'POST',
            path: AMOUNT_HANDOFF_PATH,
            body: signedBody,
          }),
        },
        body: rawBody,
      });
    }
    return { config, service, store, post, receipts, close };
  } catch (error) {
    await close();
    throw error;
  }
}
