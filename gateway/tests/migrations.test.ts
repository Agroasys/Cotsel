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
    expect(sql).toContain('ALTER COLUMN next_attempt_at TYPE TIMESTAMPTZ');
    expect(sql).toContain("USING next_attempt_at AT TIME ZONE 'UTC'");
    expect(sql).toContain('AND NOT convalidated');
    expect(sql).not.toContain(
      'DROP CONSTRAINT IF EXISTS settlement_callback_deliveries_lease_check',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gasless_commands');
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS idempotency_keys')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS managed_signer_validation_audit'),
    );
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS managed_signer_validation_audit')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS gasless_transaction_outcomes'),
    );
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS gasless_transaction_outcomes')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS gasless_commands'),
    );
  });
});
