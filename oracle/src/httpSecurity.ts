import type { Request } from 'express';
import { normalizeRoutePath, type RouteRateLimitPolicy } from '@agroasys/shared-edge';

const ORACLE_HEALTH_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'health',
  burst: { limit: 60, windowSeconds: 10 },
  sustained: { limit: 600, windowSeconds: 60 },
};

const ORACLE_MUTATION_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'mutation',
  burst: { limit: 20, windowSeconds: 10 },
  sustained: { limit: 120, windowSeconds: 60 },
};

export function oracleRateLimitPolicy(req: Pick<Request, 'path'>): RouteRateLimitPolicy | null {
  const path = normalizeRoutePath(req.path);

  if (path === '/health' || path === '/ready') {
    return ORACLE_HEALTH_RATE_LIMIT;
  }

  return ORACLE_MUTATION_RATE_LIMIT;
}
