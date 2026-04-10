/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from 'express';
import { normalizeRoutePath, type RouteRateLimitPolicy } from '@agroasys/shared-edge';

const SYSTEM_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'system',
  burst: { limit: 120, windowSeconds: 10 },
  sustained: { limit: 1200, windowSeconds: 60 },
};

const READ_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'read',
  burst: { limit: 60, windowSeconds: 10 },
  sustained: { limit: 600, windowSeconds: 60 },
};

const WRITE_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'write',
  burst: { limit: 20, windowSeconds: 10 },
  sustained: { limit: 120, windowSeconds: 60 },
};

export function gatewayRateLimitPolicy(
  req: Pick<Request, 'path' | 'method'>,
): RouteRateLimitPolicy | null {
  const path = normalizeRoutePath(req.path);

  if (path === '/healthz' || path === '/readyz' || path === '/version') {
    return SYSTEM_RATE_LIMIT;
  }

  if (req.method.toUpperCase() === 'GET' || req.method.toUpperCase() === 'HEAD') {
    return READ_RATE_LIMIT;
  }

  return WRITE_RATE_LIMIT;
}
