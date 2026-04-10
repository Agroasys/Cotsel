interface LogMeta {
  tradeId?: string | null;
  actionKey?: string | null;
  requestId?: string | null;
  txHash?: string | null;
  chainId?: string | number | null;
  networkName?: string | null;
  traceId?: string | null;
  [key: string]: unknown;
}

const SERVICE_NAME = 'reconciliation';

function baseContext(meta?: LogMeta): Record<string, unknown> {
  return {
    service: SERVICE_NAME,
    env: process.env.NODE_ENV || 'development',
    tradeId: meta?.tradeId ?? null,
    actionKey: meta?.actionKey ?? null,
    requestId: meta?.requestId ?? null,
    txHash: meta?.txHash ?? null,
    chainId: meta?.chainId ?? process.env.CHAIN_ID ?? null,
    networkName:
      meta?.networkName ??
      process.env.NETWORK_NAME ??
      process.env.STAGING_E2E_REAL_NETWORK_NAME ??
      null,
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
      console.error(JSON.stringify(payload));
      return;
    }

    if (level === 'warn') {
      console.warn(JSON.stringify(payload));
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

  static error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }
}
