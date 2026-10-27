export declare const FIELD_CLASS: Readonly<{
  PUBLIC: 'public_operational';
  INTERNAL: 'internal_operational';
  ENDPOINT: 'endpoint_origin';
  NETWORK_ADDRESS: 'masked_network_address';
}>;

export type TelemetryFieldClass = (typeof FIELD_CLASS)[keyof typeof FIELD_CLASS];

export declare const TELEMETRY_SCHEMA_VERSION: string;
export declare const TELEMETRY_FIELD_POLICY: ReadonlyMap<string, TelemetryFieldClass>;

export function classifyTelemetryField(
  name: string,
): TelemetryFieldClass | 'prohibited' | 'unclassified';
export function isProhibitedField(name: string): boolean;
