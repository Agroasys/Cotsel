/**
 * SPDX-License-Identifier: Apache-2.0
 */
interface LogMeta {
  requestId?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  walletAddress?: string | null;
  gatewayRoles?: string[] | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  [key: string]: unknown;
}

const SERVICE_NAME = 'gateway';
const REDACT_KEYS = new Set([
  'authorization',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'password',
  'hmacSecret',
]);

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (REDACT_KEYS.has(key)) {
          return [key, '[REDACTED]'];
        }
        return [key, redactValue(entry)];
      }),
    );
  }

  return value;
}

function baseContext(meta?: LogMeta): Record<string, unknown> {
  return redactValue({
    service: SERVICE_NAME,
    env: process.env.NODE_ENV || 'development',
    requestId: meta?.requestId ?? null,
    correlationId: meta?.correlationId ?? null,
    userId: meta?.userId ?? null,
    walletAddress: meta?.walletAddress ?? null,
    gatewayRoles: meta?.gatewayRoles ?? null,
    route: meta?.route ?? null,
    method: meta?.method ?? null,
    statusCode: meta?.statusCode ?? null,
    durationMs: meta?.durationMs ?? null,
    ...meta,
  }) as Record<string, unknown>;
}

function normalizeMeta(metaOrError?: unknown): LogMeta | undefined {
  if (!metaOrError) return undefined;
  if (metaOrError instanceof Error) {
    return { error: metaOrError.message, stack: metaOrError.stack };
  }
  if (typeof metaOrError === 'object') {
    return metaOrError as LogMeta;
  }
  return { error: String(metaOrError) };
}

export class Logger {
  private static write(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: LogMeta): void {
    const payload = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...baseContext(meta),
    };

    if (level === 'error') {
      console.error(JSON.stringify(payload));
      return;
    }

    if (level === 'warn') {
      console.warn(JSON.stringify(payload));
      return;
    }

    if (level === 'debug') {
      if (process.env.NODE_ENV === 'development') {
        console.debug(JSON.stringify(payload));
      }
      return;
    }

    console.log(JSON.stringify(payload));
  }

  static info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  static warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  static error(message: string, metaOrError?: unknown): void {
    this.write('error', message, normalizeMeta(metaOrError));
  }

  static debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }
}
