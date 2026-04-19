import type { Request, RequestHandler } from 'express';

export interface RateLimitWindowConfig {
  limit: number;
  windowSeconds: number;
}

export interface RouteRateLimitPolicy {
  name: string;
  burst: RateLimitWindowConfig;
  sustained: RateLimitWindowConfig;
}

export interface RateLimiterLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CallerContext {
  key: string;
  keyType: 'ip' | 'apiKey+ip';
  fingerprint: string;
}

export interface HttpRateLimiterOptions {
  enabled: boolean;
  redisUrl?: string;
  nodeEnv: string;
  keyPrefix: string;
  classifyRoute: (req: Request) => RouteRateLimitPolicy | null;
  resolveCallerContext?: (req: Request) => CallerContext;
  logger?: RateLimiterLogger;
  nowSeconds?: () => number;
  failOpenOnStoreError?: boolean;
  onStoreError?: (event: {
    keyPrefix: string;
    method: string;
    path: string;
    failOpen: boolean;
    error: unknown;
  }) => void;
  store?: {
    incrementAndGet(
      key: string,
      windowSeconds: number,
      nowSeconds: number,
    ): Promise<{ count: number; resetSeconds: number }>;
    close(): Promise<void>;
  };
}

export interface HttpRateLimiter {
  middleware: RequestHandler;
  close: () => Promise<void>;
  mode: 'disabled' | 'memory' | 'redis';
}

export function createHttpRateLimiter(options: HttpRateLimiterOptions): Promise<HttpRateLimiter>;
export function normalizeRoutePath(pathname: string): string;
