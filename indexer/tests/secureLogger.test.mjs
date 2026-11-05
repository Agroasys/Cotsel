import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { serializeSubsquidLogRecord } from '../lib/secureLogger.js';

const primary = 'https://base-sepolia.example/v3/primary-secret';
const fallback = 'https://fallback.example/v2/fallback-secret?key=hidden';

test('redacts RPC URLs in log records and errors', () => {
  const error = new Error(`Got 429 from ${primary}`);
  error.rpcUrl = primary;
  error.response = {
    requestUrl: fallback,
    detail: `retry ${fallback}`,
  };

  const serialized = serializeSubsquidLogRecord({
    rpcUrl: primary,
    fallbackRpcUrls: [fallback],
    err: error,
  });

  assert.doesNotMatch(serialized, /primary-secret/);
  assert.doesNotMatch(serialized, /fallback-secret/);
  assert.doesNotMatch(serialized, /key=hidden/);
  assert.match(serialized, /base-sepolia\.example\/\[redacted\]/);
  assert.match(serialized, /fallback\.example\/\[redacted\]/);
  assert.match(serialized, /Got 429/);
});

test('keeps classified context and drops raw RPC and SQL attributes by name', () => {
  const sanitized = JSON.parse(
    serializeSubsquidLogRecord({
      level: 4,
      ns: 'sqd:processor',
      msg: 'processing block',
      blockNumber: 45807259n,
      rpcMsg: { method: 'eth_getLogs', params: [{ address: '0xabc' }] },
      sql: 'SELECT * FROM trade',
    }),
  );

  assert.deepEqual(sanitized, {
    level: 4,
    ns: 'sqd:processor',
    msg: 'processing block',
    blockNumber: '45807259',
    telemetryDroppedFields: ['rpcMsg', 'sql'],
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

test('archive HTTP debug logs never expose Gateway authorization headers', () => {
  const secret = 'demo-gateway-key-must-never-appear';
  const script = `
    require('./lib/secureLogger.js');
    const { createRequire } = require('node:module');
    const { createServer } = require('node:http');
    const { createLogger } = require('@subsquid/logger');
    const dependencyRequire = createRequire(require.resolve('@subsquid/evm-processor'));
    const { HttpClient } = dependencyRequire('@subsquid/http-client');
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ height: 1 }));
    });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const client = new HttpClient({ log: createLogger('sqd:processor:archive') });
        await client.get('http://127.0.0.1:' + server.address().port + '/height', {
          headers: { Authorization: 'Bearer ' + process.env.SQD_API_KEY, Token: process.env.SQD_API_KEY },
        });
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    })().catch(() => { process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, SQD_API_KEY: secret, SQD_DEBUG: 'sqd:processor:archive' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.match(result.stderr, /http request/);
  assert.match(result.stderr, /httpRequestHeaders/);
});
