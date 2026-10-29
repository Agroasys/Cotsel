/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { serializeTelemetryRecord } from '@agroasys/shared-telemetry';

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

function baseContext(meta?: LogMeta): Record<string, unknown> {
  return {
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
  };
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
  private static write(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    meta?: LogMeta,
  ): void {
    const payload = serializeTelemetryRecord({
      level,
      timestamp: new Date().toISOString(),
      message,
      ...baseContext(meta),
    });

    if (level === 'error') {
      console.error(payload);
      return;
    }

    if (level === 'warn') {
      console.warn(payload);
      return;
    }

    if (level === 'debug') {
      if (process.env.NODE_ENV === 'development') {
        console.debug(payload);
      }
      return;
    }

    console.log(payload);
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
