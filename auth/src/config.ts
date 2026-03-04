/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { AuthConfig } from './types';

dotenv.config();

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
  const required = raw ?? env(name);
  const num = parseInt(required, 10);
  assert(!isNaN(num), `${name} must be a number`);
  return num;
}

function loadConfig(): AuthConfig {
  return {
    port: envNumber('PORT', 3005),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT', 5432),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    sessionTtlSeconds: envNumber('SESSION_TTL_SECONDS', 3600),
  };
}

export const config = loadConfig();
