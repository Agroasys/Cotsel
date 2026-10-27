export declare const REDACTED: string;

export function maskNetworkAddress(value: unknown): string;
export function endpointOrigin(value: string): string;
export function scrubString(value: string): string;
export function sanitizeTelemetryRecord(record: unknown): Record<string, unknown>;
export function serializeTelemetryRecord(record: unknown): string;
