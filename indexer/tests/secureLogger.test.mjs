import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { sanitizeSubsquidLogValue } from '../lib/secureLogger.js';

const primary = 'https://base-sepolia.example/v3/primary-secret';
const fallback = 'https://fallback.example/v2/fallback-secret?key=hidden';

test('redacts configured RPC URLs in nested log records and errors', () => {
  const error = new Error(`Got 429 from ${primary}`);
  error.rpcUrl = primary;
  error.response = {
    requestUrl: fallback,
    detail: `retry ${fallback}`,
  };

  const sanitized = sanitizeSubsquidLogValue(
    {
      rpcUrl: primary,
      fallback,
      err: error,
    },
    [primary, fallback],
  );
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /primary-secret/);
  assert.doesNotMatch(serialized, /fallback-secret/);
  assert.doesNotMatch(serialized, /key=hidden/);
  assert.match(serialized, /base-sepolia\.example\/\[redacted\]/);
  assert.match(serialized, /fallback\.example\/\[redacted\]/);
  assert.match(serialized, /Got 429/);
});

test('preserves non-secret structured context', () => {
  const sanitized = sanitizeSubsquidLogValue(
    {
      level: 4,
      rpcMethod: 'eth_getLogs',
      block: 45807259n,
    },
    [primary],
  );

  assert.deepEqual(sanitized, {
    level: 4,
    rpcMethod: 'eth_getLogs',
    block: '45807259',
  });
});

test('installed root sink redacts dependency error records before stderr', () => {
  const script = `
    require('./lib/secureLogger.js');
    const { createLogger } = require('@subsquid/logger');
    const rpcUrl = process.env.RPC_ENDPOINT;
    const error = new Error('Got 429 from ' + rpcUrl);
    error.rpcUrl = rpcUrl;
    createLogger('sqd:rpc-client', { rpcUrl }).error({ err: error }, 'connection failure');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RPC_ENDPOINT: primary,
      RPC_FALLBACK_ENDPOINTS: fallback,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /primary-secret/);
  assert.match(result.stderr, /base-sepolia\.example\/\[redacted\]/);
  assert.match(result.stderr, /connection failure/);
  assert.match(result.stderr, /Got 429/);
});
