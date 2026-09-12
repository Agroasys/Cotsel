/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';
import { getAddress, isAddress } from 'ethers';
import type { GatewayConfig } from './gatewayConfig';

export function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }

  const value = raw ?? env(name);
  const parsed = Number.parseInt(value, 10);
  assert(!Number.isNaN(parsed), `${name} must be a number`);
  return parsed;
}

export function envPositiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }

  const value = raw ?? env(name);
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed > 0, `${name} must be a positive integer`);
  return parsed;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  assert(/^\d+$/.test(raw), `${name} must be a non-negative integer`);
  return BigInt(raw);
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseUrlList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.replace(/\/$/, ''));
}

export function parseDbSslMode(value: string | undefined): GatewayConfig['dbSslMode'] {
  const mode = value?.trim() || 'disable';
  assert(
    mode === 'disable' || mode === 'require' || mode === 'verify-full',
    'DB_SSL_MODE must be one of disable, require, or verify-full',
  );
  return mode;
}

export function assertAddress(name: string, value: string): string {
  assert(isAddress(value), `${name} must be a valid EVM address`);
  return getAddress(value);
}

export function assertPrivateKey(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  assert(/^0x[a-fA-F0-9]{64}$/.test(value), `${name} must be a 32-byte hex private key`);
  return value;
}
