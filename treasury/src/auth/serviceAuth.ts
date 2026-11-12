import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware as createSharedServiceAuthMiddleware,
  parseServiceApiKeys,
  signServiceAuthCanonicalString,
  type ServiceApiKey,
  type ServiceAuthContext,
  type ServiceAuthMiddlewareOptions,
} from '@agroasys/shared-auth/serviceAuth';
import { incrementAuthFailure, incrementReplayReject } from '../metrics/counters';
import { Logger } from '../utils/logger';

export {
  buildServiceAuthCanonicalString,
  parseServiceApiKeys,
  signServiceAuthCanonicalString,
  type ServiceApiKey,
  type ServiceAuthContext,
  type ServiceAuthMiddlewareOptions,
};

export function createServiceAuthMiddleware(options: ServiceAuthMiddlewareOptions) {
  return createSharedServiceAuthMiddleware({
    ...options,
    onAuthFailure: incrementAuthFailure,
    onReplayReject: incrementReplayReject,
    onNonceStoreError: (correlationId, error) =>
      Logger.error('Authentication nonce store unavailable', { correlationId, error }),
  });
}
