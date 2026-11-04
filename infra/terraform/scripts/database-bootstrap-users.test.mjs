import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  new URL('../staging-platform/database-bootstrap.tf', import.meta.url),
  'utf8',
);
const match = source.match(/database_bootstrap_command = <<-COMMAND\n([\s\S]*?)\n {2}COMMAND/);
assert.ok(match, 'database bootstrap command is missing');

test('each database bootstrap step uses the intended identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-bootstrap-users-'));
  try {
    const command = match[1]
      .replace(/^ {4}/gm, '')
      .replaceAll('$${', '${')
      .replaceAll('${local.postgres_host}', 'db.invalid');
    for (const [name, content] of Object.entries({
      wget: '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-O" ]; then touch "$2"; exit; fi; shift; done\n',
      sha256sum: '#!/bin/sh\ncat >/dev/null\n',
      psql: '#!/bin/sh\ncat >/dev/null\nprintf "%s %s\\n" "$PGUSER" "$2" >> "$TEST_LOG"\n',
    })) {
      const path = join(dir, name);
      writeFileSync(path, content);
      chmodSync(path, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TEST_LOG: join(dir, 'log'),
      MASTER_USERNAME: 'master',
      MASTER_PASSWORD: 'test',
    };
    for (const [key, user] of Object.entries({
      INDEXER_MIGRATION: 'cotsel_indexer_migrator',
      INDEXER_RUNTIME: 'cotsel_indexer_app',
      INDEXER_READER: 'cotsel_indexer_reader',
      RECONCILIATION_MIGRATION: 'cotsel_reconciliation_migrator',
      RECONCILIATION_READER: 'cotsel_reconciliation_reader',
      RICARDIAN_MIGRATION: 'cotsel_ricardian_migrator',
      RICARDIAN_RUNTIME: 'cotsel_ricardian_runtime',
      TREASURY_MIGRATION: 'cotsel_treasury_migrator',
      TREASURY_RUNTIME: 'cotsel_treasury_runtime',
    })) {
      env[`${key}_USERNAME`] = user;
      env[`${key}_PASSWORD`] = 'test';
    }
    const result = spawnSync('sh', ['-ec', command], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(env.TEST_LOG, 'utf8').trim().split('\n'), [
      'master postgres',
      'cotsel_reconciliation_migrator cotsel_reconciliation',
      'master cotsel_indexer',
      'cotsel_indexer_migrator cotsel_indexer',
      'master cotsel_ricardian',
      'cotsel_ricardian_migrator cotsel_ricardian',
      'master cotsel_treasury',
      'cotsel_treasury_migrator cotsel_treasury',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
