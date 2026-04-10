import type { Request } from 'express';
import type { RouteRateLimitPolicy } from '@agroasys/shared-edge';

const TREASURY_HEALTH_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'health',
  burst: { limit: 60, windowSeconds: 10 },
  sustained: { limit: 600, windowSeconds: 60 },
};

const TREASURY_READ_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'read',
  burst: { limit: 60, windowSeconds: 10 },
  sustained: { limit: 600, windowSeconds: 60 },
};

const TREASURY_WRITE_RATE_LIMIT: RouteRateLimitPolicy = {
  name: 'write',
  burst: { limit: 20, windowSeconds: 10 },
  sustained: { limit: 120, windowSeconds: 60 },
};

function normalizeRoutePath(pathname: string): string {
  if (pathname.length <= 1) {
    return pathname;
  }

  const normalized = pathname.replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

export function treasuryRateLimitPolicy(req: Pick<Request, 'path' | 'method'>): RouteRateLimitPolicy | null {
  const path = normalizeRoutePath(req.path);

  if (path === '/health' || path === '/ready') {
    return TREASURY_HEALTH_RATE_LIMIT;
  }

  if (req.method.toUpperCase() === 'GET') {
    return TREASURY_READ_RATE_LIMIT;
  }

  return TREASURY_WRITE_RATE_LIMIT;
}

