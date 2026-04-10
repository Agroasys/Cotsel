/**
 * SPDX-License-Identifier: Apache-2.0
 */

interface LogMeta {
  userId?: string | null;
  walletAddress?: string | null;
  sessionId?: string | null;
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
    walletAddress: meta?.walletAddress ?? null,
    sessionId: meta?.sessionId ?? null,
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
      JSON.stringify({
        level: 'info',
        timestamp: this.formatTimestamp(),
        message,
        ...baseContext(meta),
      }),
    );
  }

  static warn(message: string, meta?: LogMeta): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        timestamp: this.formatTimestamp(),
        message,
        ...baseContext(meta),
      }),
    );
  }

  static error(message: string, metaOrError?: unknown): void {
    console.error(
      JSON.stringify({
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
        JSON.stringify({
          level: 'debug',
          timestamp: this.formatTimestamp(),
          message,
          ...baseContext(meta),
        }),
      );
    }
  }
}
