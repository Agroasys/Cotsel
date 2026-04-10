import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createCorsOptions } from '@agroasys/shared-edge';
import { config } from './config';
import { RicardianController } from './api/controller';
import { createRouter } from './api/routes';
import { closeConnection, testConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { createServiceAuthMiddleware } from './auth/serviceAuth';
import { createRicardianRateLimiter } from './rateLimit/limiter';
import { Logger } from './utils/logger';
import { createRicardianNonceStore } from './auth/nonceStore';

async function bootstrap(): Promise<void> {
  await testConnection();
  await runMigrations();

  const app = express();
  const controller = new RicardianController();
  const apiKeysById = new Map(config.apiKeys.map((key) => [key.id, key]));
  const nonceStore = createRicardianNonceStore(config);

  const authMiddleware = createServiceAuthMiddleware({
    enabled: config.authEnabled,
    maxSkewSeconds: config.authMaxSkewSeconds,
    nonceTtlSeconds: config.nonceTtlSeconds,
    sharedSecret: config.hmacSecret,
    lookupApiKey: (apiKey) => apiKeysById.get(apiKey),
    consumeNonce: nonceStore.consume,
  });

  const rateLimiter = await createRicardianRateLimiter({
    logger: Logger,
    config: {
      enabled: config.rateLimitEnabled,
      redisUrl: config.rateLimitRedisUrl,
      nodeEnv: process.env.NODE_ENV || 'development',
      writeRoute: {
        burst: {
          limit: config.rateLimitWriteBurstLimit,
          windowSeconds: config.rateLimitWriteBurstWindowSeconds,
        },
        sustained: {
          limit: config.rateLimitWriteSustainedLimit,
          windowSeconds: config.rateLimitWriteSustainedWindowSeconds,
        },
      },
      readRoute: {
        burst: {
          limit: config.rateLimitReadBurstLimit,
          windowSeconds: config.rateLimitReadBurstWindowSeconds,
        },
        sustained: {
          limit: config.rateLimitReadSustainedLimit,
          windowSeconds: config.rateLimitReadSustainedWindowSeconds,
        },
      },
    },
  });

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors(createCorsOptions({
    allowedOrigins: config.corsAllowedOrigins,
    allowNoOrigin: config.corsAllowNoOrigin,
  })));
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    })
  );

  app.use(
    '/api/ricardian/v1',
    createRouter(controller, {
      authMiddleware,
      rateLimitMiddleware: rateLimiter.middleware,
      readinessCheck: testConnection,
    })
  );

  app.listen(config.port, () => {
    Logger.info('Ricardian service started', {
      port: config.port,
      authEnabled: config.authEnabled,
      nonceStore: config.nonceStore,
      rateLimitEnabled: config.rateLimitEnabled,
      rateLimitMode: rateLimiter.mode,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    Logger.info('Shutting down Ricardian service', { signal });
    await nonceStore.close();
    await rateLimiter.close();
    await closeConnection();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

bootstrap().catch(async (error: any) => {
  Logger.error('Ricardian bootstrap failed', { error: error?.message || error });
  await closeConnection();
  process.exit(1);
});
