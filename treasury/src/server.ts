import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { createCorsOptions, createHttpRateLimiter } from '@agroasys/shared-edge';
import { assertRpcEndpointsReachable, redactRpcUrlForLogs } from '@agroasys/sdk';
import { config } from './config';
import { createRouter } from './api/routes';
import { TreasuryController } from './api/controller';
import { closeConnection, testConnection } from './database/connection';
import { Logger } from './utils/logger';
import { TreasuryIngestionService } from './core/ingestion';
import { createServiceAuthMiddleware } from './auth/serviceAuth';
import { createProviderCallbackMiddleware } from './auth/providerCallback';
import { createTreasuryNonceStore } from './auth/nonceStore';
import { incrementAuthFailure } from './metrics/counters';
import { treasuryRateLimitPolicy } from './httpSecurity';

type ServiceAuthRequest = Request & {
  serviceAuth?: {
    apiKeyId: string;
  };
};

async function bootstrap(): Promise<void> {
  await testConnection();

  if (config.rpcUrl) {
    Logger.info('Validating RPC endpoints for treasury startup', {
      rpcUrl: redactRpcUrlForLogs(config.rpcUrl),
      fallbackRpcUrls: config.rpcFallbackUrls.map(redactRpcUrlForLogs),
    });
    await assertRpcEndpointsReachable([config.rpcUrl, ...config.rpcFallbackUrls], {
      expectedChainId: config.chainId,
    });
  }

  const shouldIngestOnce = process.argv.includes('--ingest-once');

  if (shouldIngestOnce) {
    const ingestionService = new TreasuryIngestionService();
    const result = await ingestionService.ingestOnce();
    await closeConnection();
    // A run that refused to ingest must not exit 0. This is the command a
    // scheduler and the release gate call, and both read the exit code as the
    // answer to "did treasury take in the evidence it was asked for".
    if (result.blockedReason) {
      process.exitCode = 1;
    }
    return;
  }

  const app = express();
  const controller = new TreasuryController();
  const apiKeysById = new Map(config.apiKeys.map((key) => [key.id, key]));
  const nonceStore = createTreasuryNonceStore(config);

  const authMiddleware = createServiceAuthMiddleware({
    enabled: config.authEnabled,
    maxSkewSeconds: config.authMaxSkewSeconds,
    nonceTtlSeconds: config.nonceTtlSeconds,
    sharedSecret: config.hmacSecret,
    lookupApiKey: (apiKey) => apiKeysById.get(apiKey),
    consumeNonce: nonceStore.consume,
  });
  const mutationAuthMiddleware = (req: ServiceAuthRequest, res: Response, next: NextFunction) => {
    if (!config.authEnabled) {
      next();
      return;
    }

    const apiKeyId = req.serviceAuth?.apiKeyId ?? null;
    if (!apiKeyId || !config.internalMutationApiKeys.includes(apiKeyId)) {
      res.status(403).json({
        success: false,
        code: 'INTERNAL_MUTATION_CALLER_REQUIRED',
        error: 'Treasury mutations require an approved internal caller identity',
      });
      return;
    }

    next();
  };
  // A provider names itself either in the payload it signed (`partnerCode`) or
  // in the delivery header. Neither present means no configured secret can
  // apply, and the callback is refused rather than guessed at.
  const providerCallbackMiddleware = createProviderCallbackMiddleware({
    enabled: config.providerCallbackAuthEnabled,
    secrets: config.providerWebhookSecrets,
    maxSkewSeconds: config.providerCallbackMaxSkewSeconds,
    resolvePartnerCode: (req) =>
      (req.body as { partnerCode?: string } | undefined)?.partnerCode ??
      req.header('x-webhook-partner') ??
      undefined,
    resolveBodyEventId: (req) =>
      (req.body as { providerEventId?: string } | undefined)?.providerEventId,
    onReject: incrementAuthFailure,
  });

  if (config.providerCallbackAuthEnabled && config.providerWebhookSecrets.length === 0) {
    Logger.warn('Provider callback verification is enabled with no configured webhook secrets', {
      effect: 'every provider callback will be rejected until a secret is configured',
    });
  }

  const requestRateLimiter = await createHttpRateLimiter({
    enabled: config.rateLimitEnabled,
    redisUrl: config.rateLimitRedisUrl,
    nodeEnv: config.nodeEnv,
    keyPrefix: 'treasury',
    classifyRoute: treasuryRateLimitPolicy,
    logger: Logger,
  });

  app.use(helmet());
  app.disable('x-powered-by');
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

  app.use(
    '/api/treasury/v1',
    requestRateLimiter.middleware,
    createRouter(controller, {
      authMiddleware,
      mutationAuthMiddleware,
      providerCallbackMiddleware,
      readinessCheck: testConnection,
    }),
  );

  app.listen(config.port, () => {
    Logger.info('Treasury service started', {
      port: config.port,
      indexerGraphqlUrl: config.indexerGraphqlUrl,
      authEnabled: config.authEnabled,
      providerCallbackAuthEnabled: config.providerCallbackAuthEnabled,
      nonceStore: config.nonceStore,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    Logger.info('Shutting down treasury service', { signal });
    await nonceStore.close();
    await requestRateLimiter.close();
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

bootstrap().catch(async (error: unknown) => {
  Logger.error('Treasury bootstrap failed', {
    error: error instanceof Error ? error.message : error,
  });

  await closeConnection();
  process.exit(1);
});
