/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';

describe('gasless command admission policy', () => {
  test('does not hold a fleet-wide capacity lock across settlement transactions', () => {
    const repositoryRoot = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(
      path.join(repositoryRoot, 'gateway/src/core/postgresGaslessCommandQueries.ts'),
      'utf8',
    );
    const decision = fs.readFileSync(
      path.join(repositoryRoot, 'docs/adr/adr-0414-durable-gasless-command-dispatch.md'),
      'utf8',
    );

    expect(source).not.toContain('pg_advisory_xact_lock');
    expect(source).not.toContain('gasless-command-capacity');
    expect(decision).toContain('soft admission guard');
    expect(decision).toContain('command identity constraints remain hard invariants');
  });
});
