import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createServiceNotifications } = require('@agroasys/notifications');
const { WebhookIndexerAlerts } = require('../lib/alerts');
const NotificationOutboxMigration = require('../db/migrations/1785700000000-NotificationOutbox.js');
const {
  createAdminPool,
  dockerAvailable,
  runSql,
  withPostgresContainer,
} = require('../../shared-db/postgres-test-support');

const ENTRY = {
  blockNumber: 4242,
  blockHash: '0xblockhash',
  txHash: '0xtxhash',
  logIndex: 2,
  transactionIndex: 1,
  contractAddress: '0x00000000000000000000000000000000000000aa',
  topics: ['0xtopic0'],
  data: '0xdeadbeef',
  reason: 'UNDECODABLE',
  errorMessage: 'no matching event',
  abiFingerprint: 'd'.repeat(64),
  eventName: null,
};

const quietLogger = { info() {}, warn() {}, error() {} };

function notificationsFor(pool) {
  return createServiceNotifications({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/indexer',
    cooldownMs: 0,
    requestTimeoutMs: 1000,
    executor: pool,
    logger: quietLogger,
  });
}

test(
  'a poison-log alert raised while the webhook is down is delivered after a restart',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    const originalFetch = global.fetch;
    await withPostgresContainer(async ({ port }) => {
      const pool = await createAdminPool(port);
      const db = { query: (sql, values) => runSql(pool, sql, values) };

      try {
        await new NotificationOutboxMigration().up(db);

        global.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
        const crashed = notificationsFor(pool);
        await new WebhookIndexerAlerts(crashed.notifier).poisonLogDetected(ENTRY);
        await crashed.dispatcher.stop();

        const pending = await runSql(
          pool,
          `SELECT state, attempts, event FROM notification_outbox`,
        );
        assert.equal(pending.rows.length, 1);
        assert.equal(pending.rows[0].state, 'PENDING');
        assert.equal(pending.rows[0].attempts, 1);
        assert.equal(pending.rows[0].event.type, 'INDEXER_POISON_LOG');
        assert.equal(pending.rows[0].event.dedupKey, 'indexer:poison:0xtxhash:2');
        assert.equal(
          JSON.stringify(pending.rows[0].event).includes('0xdeadbeef'),
          false,
          'the raw log data never enters the alert',
        );

        await assert.rejects(
          () => new NotificationOutboxMigration().down(db),
          /Refusing to drop notification_outbox while 1 notification\(s\) are undelivered/,
        );

        const delivered = [];
        global.fetch = async (_url, init) => {
          delivered.push(JSON.parse(init.body));
          return { ok: true, status: 200, statusText: 'OK' };
        };
        // The retry backoff has not elapsed; a restarted process still owes it.
        await runSql(pool, `UPDATE notification_outbox SET next_attempt_at = NOW()`);
        const restarted = notificationsFor(pool);
        await restarted.dispatcher.runOnce();

        assert.equal(delivered.length, 1);
        assert.match(delivered[0].text, /INDEXER_POISON_LOG/);
        const settled = await runSql(pool, `SELECT state FROM notification_outbox`);
        assert.equal(settled.rows[0].state, 'DELIVERED');

        await new NotificationOutboxMigration().down(db);
        const table = await runSql(pool, `SELECT to_regclass('public.notification_outbox') AS t`);
        assert.equal(table.rows[0].t, null);
      } finally {
        global.fetch = originalFetch;
        await pool.end();
      }
    });
  },
);
