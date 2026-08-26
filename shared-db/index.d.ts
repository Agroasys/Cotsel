import type { Pool } from 'pg';

export type PostgresConnectionRole = 'runtime' | 'migration';
export type PostgresSslMode = 'disable' | 'require' | 'verify-full';

export interface BuildSessionOptionsInput {
  serviceName: string;
  connectionRole: PostgresConnectionRole;
  runtimeDbUser?: string;
}

export interface ServicePoolConfig extends BuildSessionOptionsInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  sslMode?: PostgresSslMode;
}

export function buildSessionOptions(input: BuildSessionOptionsInput): string;
export function parsePostgresSslMode(
  value: string | undefined,
  fallback?: PostgresSslMode,
): PostgresSslMode;
export function resolvePostgresSslConfig(
  mode?: PostgresSslMode,
): false | { rejectUnauthorized: boolean };
export function createServicePool(config: ServicePoolConfig): Pool;
