'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { dockerAvailable, withPostgresContainer } = require('./postgres-test-support');

for (const fails of [false, true]) {
  test(
    `disposable database removes its own anonymous volume after ${fails ? 'failure' : 'success'}`,
    { skip: !dockerAvailable, timeout: 120000 },
    async () => {
      let volume;
      const work = withPostgresContainer(async ({ containerName }) => {
        const container = JSON.parse(
          execFileSync('docker', ['inspect', containerName], { encoding: 'utf8' }),
        )[0];
        volume = container.Mounts.find(
          (mount) => mount.Destination === '/var/lib/postgresql/data',
        ).Name;
        if (fails) throw new Error('controlled scenario failure');
      });
      if (fails) await assert.rejects(work, /controlled scenario failure/);
      else await work;
      assert.ok(volume);
      let stillExists = true;
      try {
        execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' });
      } catch {
        stillExists = false;
      }
      assert.equal(stillExists, false, `Disposable test volume ${volume} was not removed`);
    },
  );
}

test('each repository PostgreSQL harness removes owned volumes with its container', () => {
  for (const file of [
    'shared-db/postgres-test-support.js',
    'auth/tests/helpers/adminControlsIntegrationHarness.ts',
    'auth/tests/operatorSignerRegister.integration.test.ts',
    'gateway/tests/helpers/governancePostgresHarness.ts',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /\['rm', '-f', '-v', containerName\]/, file);
  }
  const smoke = fs.readFileSync(
    path.join(__dirname, '../scripts/postgres-backup-restore-smoke.sh'),
    'utf8',
  );
  assert.match(smoke, /docker rm -f -v "\$SRC_CONTAINER"/);
  assert.match(smoke, /docker rm -f -v "\$DST_CONTAINER"/);
});
