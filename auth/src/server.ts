/**
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createCorsOptions, createHttpRateLimiter } from '@agroasys/shared-edge';
import {
  createServiceAuthMiddleware,
  parseServiceApiKeys,
  type ServiceApiKey,
} from '@agroasys/shared-auth/serviceAuth';
import { createPostgresNonceStore } from '@agroasys/shared-auth/nonceStore';
import { config } from './config';
import { testConnection, closeConnection, pool } from './database/connection';
import { runMigrations } from './database/migrations';
import { createPostgresProfileStore } from './core/profileStore';
import { createPostgresSessionStore } from './core/sessionStore';
import { createSessionService } from './core/sessionService';
import { createAdminService } from './core/adminService';
import { createPostgresOperatorAuthorityStore } from './core/operatorAuthorityStore';
import { createInMemoryChallengeStore } from './core/challengeStore';
import { LegacyWalletAuthController, SessionController } from './api/controller';
import { AdminController } from './api/adminController';
import { createRouter } from './api/routes';
import { authRateLimitPolicy } from './httpSecurity';
import {
  incrementRateLimitFailClosed,
  incrementRateLimitFailOpen,
  incrementServiceAuthDenied,
  incrementServiceAuthNonceReplay,
} from './metrics/counters';
import { errorHandler } from './middleware/middleware';
import { Logger } from './utils/logger';

let requestRateLimiterClose: (() => Promise<void>) | undefined;

function createServiceApiKeyLookup(rawKeys: string): (apiKey: string) => ServiceApiKey | undefined {
  const keys = parseServiceApiKeys(rawKeys);
  const lookup = new Map<string, ServiceApiKey>(keys.map((key) => [key.id, key]));
  return (apiKey: string) => lookup.get(apiKey);
}

function createAllowedServiceApiKeyLookup(
  rawKeys: string,
  allowedApiKeyIds: string[],
): (apiKey: string) => ServiceApiKey | undefined {
  const allowed = new Set(allowedApiKeyIds);
  const lookup = createServiceApiKeyLookup(rawKeys);
  return (apiKey: string) => {
    const key = lookup(apiKey);
    return key && allowed.has(key.id) ? key : undefined;
  };
}

async function initializeDatabase(): Promise<void> {
  Logger.info('Initializing database...');
  await testConnection();
  await runMigrations();
  Logger.info('Database initialized');
}

async function gracefulShutdown(signal: string): Promise<void> {
  Logger.info(`${signal} received, shutting down gracefully...`);
  try {
    if (requestRateLimiterClose) {
      await requestRateLimiterClose();
    }
    await closeConnection();
    Logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    Logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  await initializeDatabase();

  //  Stores & service
  const profileStore = createPostgresProfileStore(pool);
  const operatorAuthorityStore = createPostgresOperatorAuthorityStore(pool);
  const sessionStore = createPostgresSessionStore(pool);
  const sessionService = createSessionService(sessionStore, profileStore);
  const challengeStore = createInMemoryChallengeStore();
  const trustedSessionExchangeNonceStore = createPostgresNonceStore({
    tableName: 'trusted_session_exchange_nonces',
    query: (sql, params) => pool.query(sql, params),
  });
  const adminControlNonceStore = createPostgresNonceStore({
    tableName: 'auth_admin_control_nonces',
    query: (sql, params) => pool.query(sql, params),
  });
  const trustedSessionExchangeMiddleware = config.trustedSessionExchangeEnabled
    ? createServiceAuthMiddleware({
        enabled: true,
        maxSkewSeconds: config.trustedSessionExchangeMaxSkewSeconds,
        nonceTtlSeconds: config.trustedSessionExchangeNonceTtlSeconds,
        lookupApiKey: createServiceApiKeyLookup(config.trustedSessionExchangeApiKeysJson),
        consumeNonce: trustedSessionExchangeNonceStore.consume,
      })
    : undefined;
  const adminControlMiddleware = config.adminControlEnabled
    ? createServiceAuthMiddleware({
        enabled: true,
        maxSkewSeconds: config.adminControlMaxSkewSeconds,
        nonceTtlSeconds: config.adminControlNonceTtlSeconds,
        lookupApiKey: createAllowedServiceApiKeyLookup(
          config.adminControlApiKeysJson,
          config.adminControlAllowedApiKeyIds,
        ),
        consumeNonce: adminControlNonceStore.consume,
        onAuthFailure: (reason) => {
          incrementServiceAuthDenied();
          Logger.warn('Admin control service-auth denied', {
            eventType: 'auth.service_auth_denied',
            reason,
          });
        },
        onReplayReject: () => {
          incrementServiceAuthNonceReplay();
          Logger.warn('Admin control nonce replay rejected', {
            eventType: 'auth.nonce_replay_attempted',
          });
        },
      })
    : undefined;
  const requestRateLimiter = await createHttpRateLimiter({
    enabled: config.rateLimitEnabled,
    redisUrl: config.rateLimitRedisUrl,
    nodeEnv: config.nodeEnv,
    keyPrefix: 'auth',
    classifyRoute: authRateLimitPolicy,
    logger: Logger,
    failOpenOnStoreError: config.rateLimitFailOpen,
    onStoreError: (event) => {
      if (event.failOpen) {
        incrementRateLimitFailOpen();
      } else {
        incrementRateLimitFailClosed();
      }
      Logger.warn('Auth rate limiter degraded', {
        eventType: event.failOpen ? 'auth.rate_limiter_fail_open' : 'auth.rate_limiter_fail_closed',
        keyPrefix: event.keyPrefix,
        method: event.method,
        path: event.path,
      });
    },
  });
  requestRateLimiterClose = requestRateLimiter.close;

  //  Express app
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors(
      createCorsOptions({
        allowedOrigins: config.corsAllowedOrigins,
        allowNoOrigin: config.corsAllowNoOrigin,
      }),
    ),
  );
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

  const legacyWalletController = config.legacyWalletLoginEnabled
    ? new LegacyWalletAuthController(sessionService, challengeStore, config.sessionTtlSeconds)
    : undefined;
  const sessionController = new SessionController(sessionService, config.sessionTtlSeconds);
  const adminController = config.adminControlEnabled
    ? new AdminController(
        createAdminService(
          profileStore,
          operatorAuthorityStore,
          config.adminBreakGlassMaxTtlSeconds,
        ),
      )
    : undefined;
  const router = createRouter(sessionController, sessionService, {
    legacyWalletController,
    trustedSessionExchangeMiddleware,
    adminController,
    adminControlMiddleware,
  });

  app.use('/api/auth/v1', requestRateLimiter.middleware, router);
  app.use(errorHandler);

  //  Start
  const server = app.listen(config.port, () => {
    Logger.info(`Auth service listening on port ${config.port}`);
  });

  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  server.on('error', (error) => {
    Logger.error('Server error', error);
    process.exit(1);
  });
}

void bootstrap().catch((error) => {
  Logger.error('Failed to start auth service', error);
  process.exit(1);
});
