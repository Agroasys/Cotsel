/** SPDX-License-Identifier: Apache-2.0 */
// Isolated process fixture: loopback PostgreSQL and the real scheduled dispatcher.
import { createServer } from 'http';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { SettlementCallbackDispatcher } from '../../src/core/settlementCallbackDispatcher';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { baseTestGatewayConfig } from '../support/testConfig';

async function main() {
  const database = process.argv[2];
  if (!/^ua_[a-f0-9]{32}$/.test(database ?? '')) throw new Error('Invalid fixture database');
  const pool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database,
    user: database,
    password: 'local-test-only',
    options: '-c app.service_name=gateway',
    max: 2,
  });
  const config = {
    ...baseTestGatewayConfig,
    settlementCallbackEnabled: true,
    settlementCallbackPollIntervalMs: 20,
    settlementCallbackUrl: 'http://127.0.0.1:1/unused-callback',
    settlementCallbackApiKey: 'fixture-key',
    settlementCallbackApiSecret: 'fixture-secret',
  };
  const server = createServer(
    createApp(config, {
      version: 'test',
      commitSha: 'fixture',
      buildTime: 'fixture',
      readinessCheck: async () => {
        await pool.query('SELECT 1');
        return [{ name: 'postgres', status: 'ok' }];
      },
    }),
  );
  const dispatcher = new SettlementCallbackDispatcher(config, createPostgresSettlementStore(pool));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const repeatedPollFailure = new Promise<void>((resolve, reject) => {
      process.once('message', (message) => {
        if (message === 'verify-health') resolve();
        else reject(new Error('Invalid fixture control message'));
      });
    });
    dispatcher.start();
    await repeatedPollFailure;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1/healthz`,
    );
    if (response.status !== 200) throw new Error('Gateway stopped serving health requests');
    process.stdout.write('POLL_PROCESS_SURVIVED\n');
  } finally {
    dispatcher.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
    if (process.connected) process.disconnect();
  }
}
void main().catch(() => {
  process.stderr.write('Scheduled callback fixture failed\n');
  process.exitCode = 1;
});
