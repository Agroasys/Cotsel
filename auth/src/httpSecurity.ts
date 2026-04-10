/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from 'express';
import { normalizeRoutePath, type RouteRateLimitPolicy } from '@agroasys/shared-edge';

const HEALTH_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'health',
  burst: { limit: 60, windowSeconds: 10 },
  sustained: { limit: 600, windowSeconds: 60 },
};

const LEGACY_AUTH_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'legacy_wallet_login',
  burst: { limit: 5, windowSeconds: 60 },
  sustained: { limit: 30, windowSeconds: 300 },
};

const SESSION_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'session',
  burst: { limit: 30, windowSeconds: 60 },
  sustained: { limit: 180, windowSeconds: 300 },
};

const TRUSTED_EXCHANGE_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'trusted_session_exchange',
  burst: { limit: 30, windowSeconds: 60 },
  sustained: { limit: 180, windowSeconds: 300 },
};

export function authRateLimitPolicy(req: Pick<Request, 'path'>): RouteRateLimitPolicy | null {
  const path = normalizeRoutePath(req.path);

  if (path === '/health' || path === '/ready') {
    return HEALTH_RATE_LIMIT;
  }

  if (path === '/challenge' || path === '/login') {
    return LEGACY_AUTH_RATE_LIMIT;
  }

  if (path === '/session' || path === '/session/refresh' || path === '/session/revoke') {
    return SESSION_RATE_LIMIT;
  }

  if (path === '/session/exchange/agroasys') {
    return TRUSTED_EXCHANGE_RATE_LIMIT;
  }

  return null;
}
