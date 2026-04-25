import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

test('trusted dashboard session helper fails closed without service-auth keys', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/trusted-dashboard-session.mjs',
      '--account-id',
      'demo-admin-001',
      '--role',
      'admin',
      '--wallet-address',
      '0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a',
      '--profile-file',
      '.env.missing-for-test',
    ],
    {
      cwd: ROOT_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No active trusted session exchange API key is available/u);
  assert.doesNotMatch(result.stdout, /sessionId/u);
});
