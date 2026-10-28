import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const rpcUrl = 'https://base-sepolia.example/v3/startup-secret';

test('bootstrap records pass the telemetry schema before stderr', () => {
  const script = `
    const { logBootstrapEvent } = require('./lib/startup.js');
    logBootstrapEvent('error', 'indexer.bootstrap_failed', 'Indexer bootstrap failed', {
      error: 'eth_chainId failed against ${rpcUrl} with Bearer sk_live_0123456789abcdef',
      rawResponse: '{"secret":"value"}',
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stderr.trim());
  assert.equal(record.eventType, 'indexer.bootstrap_failed');
  assert.equal(
    record.error,
    'eth_chainId failed against https://base-sepolia.example/[redacted] with Bearer [REDACTED]',
  );
  assert.deepEqual(record.telemetryDroppedFields, ['rawResponse']);
  assert.doesNotMatch(result.stderr, /startup-secret|sk_live_|"secret"/);
});
