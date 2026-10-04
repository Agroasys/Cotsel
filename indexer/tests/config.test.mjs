import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CONFIG_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'config.js');

const BASE_ENV = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'indexer',
  DB_USER: 'indexer',
  DB_PASSWORD: 'indexer',
  RPC_ENDPOINT: 'http://127.0.0.1:8545',
  CHAIN_ID: '84532',
  START_BLOCK: '100',
  RATE_LIMIT: '10',
  FINALITY_CONFIRMATION_BLOCKS: '1',
  CONTRACT_ADDRESS: '0x00000000000000000000000000000000000000aa',
};

/** `loadConfig` exits the process on invalid input, so each case runs in its own child. */
function loadConfig(overrides = {}) {
  // An empty working directory keeps dotenv from reading a developer `.env`.
  const cwd = mkdtempSync(join(tmpdir(), 'indexer-config-'));
  try {
    const env = { PATH: process.env.PATH, ...BASE_ENV, ...overrides };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete env[key];
      }
    }
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG_MODULE)}).loadConfig()))`,
      ],
      { cwd, env, encoding: 'utf8' },
    );
    return {
      status: result.status,
      config: result.status === 0 ? JSON.parse(result.stdout) : null,
      stderr: result.stderr,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('loads readiness defaults', () => {
  const { status, config } = loadConfig();
  assert.equal(status, 0);
  assert.equal(config.readinessPort, 8090);
  assert.equal(config.readinessMaxCheckpointLagBlocks, 150);
  assert.equal(config.startBlock, 100);
});

test('accepts explicit readiness settings and a zero-confirmation profile', () => {
  const { status, config } = loadConfig({
    READINESS_PORT: '9100',
    READINESS_MAX_CHECKPOINT_LAG_BLOCKS: '0',
    FINALITY_CONFIRMATION_BLOCKS: '0',
  });
  assert.equal(status, 0);
  assert.equal(config.readinessPort, 9100);
  assert.equal(config.readinessMaxCheckpointLagBlocks, 0);
  assert.equal(config.finalityConfirmationBlocks, 0);
});

for (const [name, value, message] of [
  ['START_BLOCK', '12abc', /START_BLOCK must be an integer/],
  ['START_BLOCK', '1e3', /START_BLOCK must be an integer/],
  ['START_BLOCK', '-1', /START_BLOCK must be between/],
  ['START_BLOCK', '2147483648', /START_BLOCK must be between/],
  ['CHAIN_ID', '0', /CHAIN_ID must be between/],
  ['RATE_LIMIT', '0', /RATE_LIMIT must be between/],
  ['FINALITY_CONFIRMATION_BLOCKS', '-2', /FINALITY_CONFIRMATION_BLOCKS must be between/],
  ['DB_PORT', '70000', /DB_PORT must be between/],
  ['READINESS_PORT', '0', /READINESS_PORT must be between/],
  [
    'READINESS_MAX_CHECKPOINT_LAG_BLOCKS',
    'ten',
    /READINESS_MAX_CHECKPOINT_LAG_BLOCKS must be an integer/,
  ],
  ['RPC_REQUEST_TIMEOUT_MS', '0', /RPC_REQUEST_TIMEOUT_MS must be between/],
]) {
  test(`rejects ${name}=${value}`, () => {
    const { status, stderr } = loadConfig({ [name]: value });
    assert.equal(status, 1);
    assert.match(stderr, message);
  });
}

test('rejects a readiness port that collides with the Prometheus port', () => {
  const { status, stderr } = loadConfig({ READINESS_PORT: '9100', PROMETHEUS_PORT: '9100' });
  assert.equal(status, 1);
  assert.match(stderr, /PROMETHEUS_PORT and READINESS_PORT must differ/);
});
