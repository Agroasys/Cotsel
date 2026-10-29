import { serializeTelemetryRecord } from '@agroasys/shared-telemetry';
import { setRootSink, type LogRecord } from '@subsquid/logger';

/**
 * Every Subsquid record, ours or a dependency's, passes the shared default-deny
 * telemetry schema: RPC URLs keep only their origin, credentials and personal
 * data are scrubbed, and unclassified attributes (raw RPC messages, SQL) are
 * dropped by name.
 */
export function serializeSubsquidLogRecord(record: LogRecord | Record<string, unknown>): string {
  return serializeTelemetryRecord(record);
}

export function installSecureSubsquidLogger(): void {
  setRootSink((record: LogRecord) => {
    process.stderr.write(`${serializeSubsquidLogRecord(record)}\n`);
  });
}

installSecureSubsquidLogger();
