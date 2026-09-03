/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import { runMigrations } from '../src/database/migrations';

describe('gateway schema migration loading', () => {
  test('applies ordered schema fragments after the base schema', async () => {
    const query = jest.fn<Promise<{ rows: never[] }>, [string]>(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;

    await runMigrations(pool);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS idempotency_keys');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS managed_signer_validation_audit');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gasless_transaction_outcomes');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ');
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS idempotency_keys')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS managed_signer_validation_audit'),
    );
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS managed_signer_validation_audit')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS gasless_transaction_outcomes'),
    );
  });
});
