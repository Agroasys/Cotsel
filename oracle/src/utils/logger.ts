interface LogMeta {
  tradeId?: string | null;
  actionKey?: string | null;
  requestId?: string | null;
  txHash?: string | null;
  traceId?: string | null;
  [key: string]: unknown;
}

const SERVICE_NAME = 'oracle';

function baseContext(meta?: LogMeta): Record<string, unknown> {
  return {
    service: SERVICE_NAME,
    env: process.env.NODE_ENV || 'development',
    tradeId: meta?.tradeId ?? null,
    actionKey: meta?.actionKey ?? null,
    requestId: meta?.requestId ?? null,
    txHash: meta?.txHash ?? null,
    traceId: meta?.traceId ?? null,
    ...meta,
  };
}

function normalizeErrorMeta(metaOrError?: unknown): LogMeta | undefined {
  if (!metaOrError) {
    return undefined;
  }

  if (metaOrError instanceof Error) {
    return {
      error: metaOrError.message,
      stack: metaOrError.stack,
    };
  }

  if (typeof metaOrError === 'object') {
    return metaOrError as LogMeta;
  }

  return {
    error: String(metaOrError),
  };
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

  static audit(action: string, tradeId: string, result: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        level: 'audit',
        timestamp: this.formatTimestamp(),
        action,
        ...baseContext({
          tradeId,
          ...result,
        }),
      }),
    );
  }
}
