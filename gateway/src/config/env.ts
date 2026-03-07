/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';

dotenv.config();

export interface GatewayConfig {
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  authBaseUrl: string;
  authRequestTimeoutMs: number;
  enableMutations: boolean;
  writeAllowlist: string[];
  commitSha: string;
  buildTime: string;
  nodeEnv: string;
}

function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }

  const value = raw ?? env(name);
  const parsed = Number.parseInt(value, 10);
  assert(!Number.isNaN(parsed), `${name} must be a number`);
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw.toLowerCase() === 'true') {
    return true;
  }

  if (raw.toLowerCase() === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function loadConfig(): GatewayConfig {
  const buildTime = process.env.GATEWAY_BUILD_TIME?.trim() || new Date().toISOString();
  const authBaseUrl = env('AUTH_BASE_URL').replace(/\/$/, '');
  const writeAllowlist = parseAllowlist(process.env.GATEWAY_WRITE_ALLOWLIST);
  const enableMutations = envBool('GATEWAY_ENABLE_MUTATIONS', false);
  const nodeEnv = process.env.NODE_ENV || 'development';

  assert(authBaseUrl.startsWith('http://') || authBaseUrl.startsWith('https://'), 'AUTH_BASE_URL must be an absolute http(s) URL');
  assert(envNumber('PORT', 3600) > 0, 'PORT must be > 0');
  assert(envNumber('DB_PORT', 5432) > 0, 'DB_PORT must be > 0');
  assert(envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000) >= 1000, 'GATEWAY_AUTH_REQUEST_TIMEOUT_MS must be >= 1000');

  return {
    port: envNumber('PORT', 3600),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT', 5432),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    authBaseUrl,
    authRequestTimeoutMs: envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000),
    enableMutations,
    writeAllowlist,
    commitSha: process.env.GATEWAY_COMMIT_SHA?.trim() || 'local-dev',
    buildTime,
    nodeEnv,
  };
}
