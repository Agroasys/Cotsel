import {
  createInMemoryNonceStore,
  createRedisNonceStore,
  type NonceStore,
} from '@agroasys/shared-auth';
import { TreasuryConfig } from '../config';
import { consumeServiceAuthNonce } from '../database/queries';
import { Logger } from '../utils/logger';

export type TreasuryNonceStore = NonceStore;

export function createTreasuryNonceStore(config: TreasuryConfig): TreasuryNonceStore {
  if (config.nonceStore === 'postgres') {
    return {
      consume: consumeServiceAuthNonce,
      close: async () => undefined,
    };
  }

  if (config.nonceStore === 'redis') {
    return createRedisNonceStore({
      redisUrl: config.nonceRedisUrl!,
      keyPrefix: 'treasury_auth_nonce',
    });
  }

  Logger.warn('Using in-memory nonce store for treasury service', {
    nodeEnv: process.env.NODE_ENV || 'development',
  });

  return createInMemoryNonceStore();
}
