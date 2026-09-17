import { createInMemoryNonceStore, createRedisNonceStore } from '@agroasys/shared-auth';
import { createRelayerApp } from './app';
import { loadRelayerConfig } from './config';
import { createKmsRelayerSigner } from './kmsRelayerSigner';
import { logger } from './logger';

async function bootstrap(): Promise<void> {
  const config = loadRelayerConfig();
  const authNonceStore = config.redisUrl
    ? createRedisNonceStore({ redisUrl: config.redisUrl, keyPrefix: 'cotsel:relayer:auth' })
    : createInMemoryNonceStore();
  const requestStore = config.redisUrl
    ? createRedisNonceStore({ redisUrl: config.redisUrl, keyPrefix: 'cotsel:relayer:request' })
    : createInMemoryNonceStore();
  const signer = createKmsRelayerSigner(config);
  const signerAddress = await signer.getAddress();
  const app = createRelayerApp(config, { signer, authNonceStore, requestStore });
  const server = app.listen(config.port, () => {
    logger.info('Gasless relayer started', {
      port: config.port,
      chainId: config.chainId,
      signerAddress,
      custodyMode: 'kms',
    });
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info('Gasless relayer shutdown started', { signal });
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([authNonceStore.close(), requestStore.close()]);
    } catch (error) {
      logger.error('Gasless relayer shutdown failed', {
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  logger.error('Gasless relayer failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
