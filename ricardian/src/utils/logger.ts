import { serializeTelemetryRecord } from '@agroasys/shared-telemetry';

interface LogMeta {
  tradeId?: string | null;
  actionKey?: string | null;
  requestId?: string | null;
  txHash?: string | null;
  traceId?: string | null;
  [key: string]: unknown;
}

const SERVICE_NAME = 'ricardian';

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

export class Logger {
  private static write(level: 'info' | 'warn' | 'error', message: string, meta?: LogMeta): void {
    const payload = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...baseContext(meta),
    };

    if (level === 'error') {
      console.error(serializeTelemetryRecord(payload));
      return;
    }

    if (level === 'warn') {
      console.warn(serializeTelemetryRecord(payload));
      return;
    }

    console.log(serializeTelemetryRecord(payload));
  }

  static info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  static warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  static error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }
}
