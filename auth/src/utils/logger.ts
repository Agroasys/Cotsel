/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { serializeTelemetryRecord } from '@agroasys/shared-telemetry';

interface LogMeta {
  userId?: string | null;
  requestId?: string | null;
  role?: string | null;
  [key: string]: unknown;
}

const SERVICE_NAME = 'auth';

function baseContext(meta?: LogMeta): Record<string, unknown> {
  return {
    service: SERVICE_NAME,
    env: process.env.NODE_ENV ?? 'development',
    userId: meta?.userId ?? null,
    requestId: meta?.requestId ?? null,
    role: meta?.role ?? null,
    ...meta,
  };
}

function normalizeErrorMeta(metaOrError?: unknown): LogMeta | undefined {
  if (!metaOrError) return undefined;
  if (metaOrError instanceof Error) {
    return { error: metaOrError.message, stack: metaOrError.stack };
  }
  if (typeof metaOrError === 'object') return metaOrError as LogMeta;
  return { error: String(metaOrError) };
}

export class Logger {
  private static formatTimestamp(): string {
    return new Date().toISOString();
  }

  static info(message: string, meta?: LogMeta): void {
    console.log(
      serializeTelemetryRecord({
        level: 'info',
        timestamp: this.formatTimestamp(),
        message,
        ...baseContext(meta),
      }),
    );
  }

  static warn(message: string, meta?: LogMeta): void {
    console.warn(
      serializeTelemetryRecord({
        level: 'warn',
        timestamp: this.formatTimestamp(),
        message,
        ...baseContext(meta),
      }),
    );
  }

  static error(message: string, metaOrError?: unknown): void {
    console.error(
      serializeTelemetryRecord({
        level: 'error',
        timestamp: this.formatTimestamp(),
        message,
        ...baseContext(normalizeErrorMeta(metaOrError)),
      }),
    );
  }

  static debug(message: string, meta?: LogMeta): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(
        serializeTelemetryRecord({
          level: 'debug',
          timestamp: this.formatTimestamp(),
          message,
          ...baseContext(meta),
        }),
      );
    }
  }
}
