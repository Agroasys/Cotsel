/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';

export function envPositiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) return fallback;

  const parsed = Number(raw);
  assert(Number.isInteger(parsed) && parsed > 0, `${name} must be a positive integer`);
  return parsed;
}
