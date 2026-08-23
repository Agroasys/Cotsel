import { setRootSink, type LogRecord } from '@subsquid/logger';

function configuredRpcUrls(): string[] {
  return [process.env.RPC_ENDPOINT, ...(process.env.RPC_FALLBACK_ENDPOINTS ?? '').split(',')]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0);
}

function redactedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}/[redacted]`;
  } catch {
    return '[redacted-rpc-url]';
  }
}

function sanitizeString(value: string, rpcUrls: string[]): string {
  return rpcUrls.reduce(
    (sanitized, rpcUrl) => sanitized.split(rpcUrl).join(redactedOrigin(rpcUrl)),
    value,
  );
}

export function sanitizeSubsquidLogValue(
  value: unknown,
  rpcUrls: string[],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value, rpcUrls);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, rpcUrls),
      stack: value.stack ? sanitizeString(value.stack, rpcUrls) : undefined,
      ...(sanitizeSubsquidLogValue(
        Object.fromEntries(Object.entries(value)),
        rpcUrls,
        seen,
      ) as Record<string, unknown>),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSubsquidLogValue(entry, rpcUrls, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizeSubsquidLogValue(entry, rpcUrls, seen),
    ]),
  );
}

export function installSecureSubsquidLogger(): void {
  const rpcUrls = configuredRpcUrls();

  setRootSink((record: LogRecord) => {
    const sanitized = sanitizeSubsquidLogValue(record, rpcUrls);
    process.stderr.write(`${JSON.stringify(sanitized)}\n`);
  });
}

installSecureSubsquidLogger();
