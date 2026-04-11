import { Request, RequestHandler } from 'express';
import {
  createHttpRateLimiter,
  normalizeRoutePath,
  type HttpRateLimiter,
  type RouteRateLimitPolicy,
} from '@agroasys/shared-edge';
import { Logger } from '../utils/logger';

export interface RateLimitWindowConfig {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitRouteConfig {
  burst: RateLimitWindowConfig;
  sustained: RateLimitWindowConfig;
}

export interface RicardianRateLimitConfig {
  enabled: boolean;
  redisUrl?: string;
  nodeEnv: string;
  writeRoute: RateLimitRouteConfig;
  readRoute: RateLimitRouteConfig;
}

export interface RateLimiterLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface RateLimiterOptions {
  config: RicardianRateLimitConfig;
  logger?: RateLimiterLogger;
  nowSeconds?: () => number;
  store?: {
    incrementAndGet(
      key: string,
      windowSeconds: number,
      nowSeconds: number,
    ): Promise<{ count: number; resetSeconds: number }>;
    close(): Promise<void>;
  };
}

export interface RicardianRateLimiter {
  middleware: RequestHandler;
  close: () => Promise<void>;
  mode: 'disabled' | 'memory' | 'redis';
}

function routeKind(req: Request): 'write' | 'read' | null {
  const path = normalizeRoutePath(req.path);

  if (path === '/health') {
    return null;
  }

  if (req.method.toUpperCase() === 'POST' && path === '/hash') {
    return 'write';
  }

  if (req.method.toUpperCase() === 'GET' && path.startsWith('/hash/')) {
    return 'read';
  }

  return null;
}

function validateConfig(config: RicardianRateLimitConfig): void {
  const windows: RateLimitWindowConfig[] = [
    config.writeRoute.burst,
    config.writeRoute.sustained,
    config.readRoute.burst,
    config.readRoute.sustained,
  ];

  windows.forEach((window) => {
    if (window.limit <= 0) {
      throw new Error('Rate limit value must be > 0');
    }

    if (window.windowSeconds <= 0) {
      throw new Error('Rate limit window must be > 0');
    }
  });
}

export async function createRicardianRateLimiter(
  options: RateLimiterOptions,
): Promise<RicardianRateLimiter> {
  validateConfig(options.config);
  const routePolicies: Record<'write' | 'read', RouteRateLimitPolicy> = {
    write: {
      name: 'write',
      burst: options.config.writeRoute.burst,
      sustained: options.config.writeRoute.sustained,
    },
    read: {
      name: 'read',
      burst: options.config.readRoute.burst,
      sustained: options.config.readRoute.sustained,
    },
  };
  const limiter: HttpRateLimiter = await createHttpRateLimiter({
    enabled: options.config.enabled,
    redisUrl: options.config.redisUrl,
    nodeEnv: options.config.nodeEnv,
    keyPrefix: 'ricardian',
    classifyRoute(req: Request): RouteRateLimitPolicy | null {
      const kind = routeKind(req);
      if (!kind) {
        return null;
      }

      return routePolicies[kind];
    },
    logger: options.logger || Logger,
    nowSeconds: options.nowSeconds,
    store: options.store,
  });

  return {
    middleware: limiter.middleware,
    mode: limiter.mode,
    close: limiter.close,
  };
}
