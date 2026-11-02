import assert from 'node:assert/strict';
import test from 'node:test';
import {
  require,
  processBatch,
  WebhookIndexerAlerts,
  encodedLog,
  QuarantineStore,
  Migration,
  dockerAvailable,
  localPostgres,
  withTestPostgres,
  createAdminPool,
} from './batchFixture.mjs';

function persistenceFixture(upsert) {
  const { createEmptyOverviewCounters } = require('../lib/overviewAggregate');
  const parent = { ...encodedLog('TradeLocked'), logIndex: 1 };
  const child = encodedLog('ClaimableAccrued');
  const unrelated = {
    ...child,
    address: '0x00000000000000000000000000000000000000bb',
    logIndex: 3,
  };
  return {
    logs: [parent, child],
    ctx: {
      blocks: [
        {
          header: { height: 4242, hash: '0xblock', timestamp: 1000 },
          logs: [parent, child, unrelated],
        },
      ],
      store: {
        get: async (model) =>
          model.name === 'OverviewSnapshot' ? createEmptyOverviewCounters() : undefined,
        upsert,
      },
      log: { info() {}, error() {} },
    },
  };
}

test('late persistence failure quarantines every matched log and preserves the original error', async () => {
  const original = Object.assign(new Error('event upsert rejected'), { code: '23503' });
  let upserts = 0;
  const { ctx, logs } = persistenceFixture(async () => {
    if (++upserts === 2) throw original;
  });
  const quarantined = [];
  const alerts = [];
  await assert.rejects(
    processBatch(ctx, {
      quarantine: { recordPoisonLog: async (entry) => quarantined.push(entry) },
      alerts: new WebhookIndexerAlerts({ notify: async (entry) => alerts.push(entry) }),
      logger: { error() {} },
    }),
    (error) => error === original,
  );
  assert.equal(upserts, 2, 'the failure follows the successful trade write');
  assert.equal(quarantined.length, 2, 'unrelated-address logs are excluded');
  for (const [index, entry] of quarantined.entries()) {
    assert.equal(entry.reason, 'HANDLER_FAILURE');
    assert.equal(entry.errorMessage, 'Batch persistence failed: event upsert rejected');
    assert.equal(entry.blockNumber, 4242);
    assert.equal(entry.blockHash, '0xblock');
    assert.equal(entry.txHash, logs[index].getTransaction().hash);
    assert.equal(entry.logIndex, logs[index].logIndex);
    assert.equal(entry.transactionIndex, logs[index].transactionIndex);
    assert.equal(entry.eventName, index === 0 ? 'TradeLocked' : 'ClaimableAccrued');
    assert.deepEqual(entry.topics, logs[index].topics);
    assert.equal(entry.data, logs[index].data);
    assert.equal(alerts[index].severity, 'critical');
    assert.equal(alerts[index].metadata.reason, 'HANDLER_FAILURE');
    assert.equal(alerts[index].metadata.logIndex, entry.logIndex);
    assert.equal(alerts[index].metadata.errorMessage, entry.errorMessage);
    assert.equal(JSON.stringify(alerts[index]).includes(entry.data), false);
  }
});

test('failed evidence and alert writes do not cancel later logs or replace the persistence error', async () => {
  const original = Object.assign(new Error('projection rejected'), {
    driverError: { code: '22003' },
  });
  const { ctx } = persistenceFixture(async () => {
    throw original;
  });
  const attemptedRows = [];
  const attemptedAlerts = [];
  const logged = [];
  await assert.rejects(
    processBatch(ctx, {
      quarantine: {
        recordPoisonLog: async (entry) => {
          attemptedRows.push(entry.logIndex);
          if (entry.logIndex === 1) throw new Error('quarantine unavailable');
        },
      },
      alerts: {
        poisonLogDetected: async (entry) => {
          attemptedAlerts.push(entry.logIndex);
          if (entry.logIndex === 1) throw new Error('alert unavailable');
        },
      },
      logger: { error: (message) => logged.push(message) },
    }),
    (error) => error === original,
  );
  assert.deepEqual(attemptedRows, [1, 2]);
  assert.deepEqual(attemptedAlerts, [1, 2]);
  assert.ok(logged.some((message) => message.includes('Failed to durably quarantine')));
  assert.ok(logged.some((message) => message.includes('Failed to raise poison-log alert')));
});

test('persistence failure without matching logs holds the batch without fabricated quarantine rows', async () => {
  const original = new Error('overview unavailable');
  const { ctx } = persistenceFixture(async () => {
    throw original;
  });
  ctx.blocks[0].logs = [ctx.blocks[0].logs[2]];
  await assert.rejects(
    processBatch(ctx, {
      quarantine: { recordPoisonLog: async () => assert.fail('no matching raw log exists') },
      alerts: { poisonLogDetected: async () => assert.fail('no matching raw log exists') },
      logger: { error() {} },
    }),
    (error) => error === original,
  );
});

test(
  'real Store persistence failure rolls back the Subsquid checkpoint but retains every raw log and critical page',
  { skip: !dockerAvailable && !localPostgres, timeout: 180000 },
  async () => {
    await withTestPostgres(async ({ port, createPool }) => {
      const { DataSource } = require('typeorm');
      const { TypeormDatabase } = require('@subsquid/typeorm-store');
      const { DurableNotifier, NotificationOutbox } = require('@agroasys/notifications');
      const models = require('../lib/model');
      const NotificationMigration = require('../db/migrations/1785700000000-NotificationOutbox.js');
      const pool = createPool ? createPool() : await createAdminPool(port);
      const quarantinePool = createPool ? createPool() : await createAdminPool(port);
      let database;
      let source;
      try {
        const schema = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
        const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
        await new Migration().up({ query: (sql, params) => pool.query(sql, params) });
        await new NotificationMigration().up({ query: (sql, params) => pool.query(sql, params) });
        source = await new DataSource({
          type: 'postgres',
          host: pool.options.host,
          port: pool.options.port,
          username: pool.options.user,
          password: pool.options.password,
          database: pool.options.database,
          schema,
          extra: { options: pool.options.options },
          entities: Object.values(models).filter((value) => typeof value === 'function'),
          synchronize: true,
        }).initialize();
        // Only connection creation is adapted. Transactions, Store writes and checkpoint updates are real.
        class FixtureDatabase extends TypeormDatabase {
          async initializeDataSource() {
            return source;
          }
        }
        database = new FixtureDatabase({ stateSchema: schema, supportHotBlocks: false });
        await database.connect();
        await database.transact(
          {
            prevHead: { height: -1, hash: '0x' },
            nextHead: { height: 4241, hash: '0xprev' },
          },
          async () => {},
        );
        const eventMetadata = source.getMetadata(models.TradeEvent);
        const eventTable = eventMetadata.tablePath.split('.').map(quote).join('.');
        const claimColumn = quote(
          eventMetadata.findColumnWithPropertyName('claimAmount').databaseName,
        );
        await pool.query(
          `ALTER TABLE ${eventTable} ADD CONSTRAINT fixture_reject_claim CHECK (${claimColumn} IS NULL)`,
        );
        const store = new QuarantineStore(quarantinePool);
        const notifier = new DurableNotifier({
          enabled: true,
          cooldownMs: 0,
          outbox: new NotificationOutbox(quarantinePool),
        });
        const deps = {
          quarantine: store,
          alerts: new WebhookIndexerAlerts(notifier),
          logger: { error() {} },
        };
        const { ctx, logs } = persistenceFixture(() => assert.fail('use the real Store'));
        const head = {
          prevHead: { height: 4241, hash: '0xprev' },
          nextHead: { height: 4242, hash: '0xblock' },
        };
        await assert.rejects(
          database.transact(head, (actualStore) =>
            processBatch({ ...ctx, store: actualStore }, deps),
          ),
          (error) =>
            error.driverError?.code === '23514' &&
            error.driverError?.constraint === 'fixture_reject_claim',
        );
        assert.equal(
          await source.manager.count(models.Trade),
          0,
          'the successful first upsert rolls back',
        );
        assert.equal(await source.manager.count(models.TradeEvent), 0);
        assert.equal(await source.manager.count(models.OverviewSnapshot), 0);
        const checkpoint = await pool.query(
          `SELECT height, hash FROM ${quote(schema)}.status WHERE id=0`,
        );
        assert.deepEqual(checkpoint.rows, [{ height: 4241, hash: '0xprev' }]);
        const retained = await pool.query(
          'SELECT * FROM indexer_quarantined_log ORDER BY log_index',
        );
        assert.equal(retained.rows.length, 2);
        for (const [index, row] of retained.rows.entries()) {
          assert.equal(row.reason, 'HANDLER_FAILURE');
          assert.match(row.error_message, /^Batch persistence failed:/);
          assert.equal(row.status, 'UNRESOLVED');
          assert.equal(row.tx_hash, logs[index].getTransaction().hash);
          assert.equal(row.log_index, logs[index].logIndex);
          assert.deepEqual(row.topics, logs[index].topics);
          assert.equal(row.data, logs[index].data);
        }
        const pages = await pool.query(
          'SELECT state, severity, event FROM notification_outbox ORDER BY id',
        );
        assert.equal(pages.rows.length, 2);
        for (const [index, row] of pages.rows.entries()) {
          assert.equal(row.state, 'PENDING');
          assert.equal(row.severity, 'critical');
          assert.equal(row.event.type, 'INDEXER_POISON_LOG');
          assert.equal(row.event.metadata.reason, 'HANDLER_FAILURE');
          assert.equal(row.event.metadata.logIndex, logs[index].logIndex);
          assert.equal(JSON.stringify(row.event).includes(logs[index].data), false);
        }
        // Operator-controlled fixture recovery: repair the cause, resolve, then replay identical logs.
        await pool.query(`ALTER TABLE ${eventTable} DROP CONSTRAINT fixture_reject_claim`);
        for (const row of retained.rows) {
          await store.resolve({
            blockNumber: Number(row.block_number),
            txHash: row.tx_hash,
            logIndex: row.log_index,
            note: 'fixture constraint repaired',
          });
        }
        await database.transact(head, (actualStore) =>
          processBatch({ ...ctx, store: actualStore }, deps),
        );
        assert.equal(await source.manager.count(models.Trade), 1);
        assert.equal(await source.manager.count(models.TradeEvent), 2);
        assert.equal(await store.countUnresolved(), 0);
        assert.equal(
          (await pool.query('SELECT count(*)::int AS count FROM notification_outbox')).rows[0]
            .count,
          2,
        );
        assert.deepEqual(
          (await pool.query(`SELECT height, hash FROM ${quote(schema)}.status WHERE id=0`)).rows,
          [{ height: 4242, hash: '0xblock' }],
        );
      } finally {
        if (database) await database.disconnect();
        if (source?.isInitialized) await source.destroy();
        await quarantinePool.end();
        await pool.end();
      }
    });
  },
);

for (const code of ['40001', '40P01', '57P01', '08006', 'ECONNRESET', undefined]) {
  test(`persistence ${code ?? 'unclassified'} failure retries without quarantine or critical pages`, async () => {
    const original = Object.assign(new Error('temporary persistence failure'), { code });
    let fail = true;
    const { ctx } = persistenceFixture(async () => {
      if (fail) throw original;
    });
    const deps = {
      quarantine: {
        recordPoisonLog: async () => assert.fail('retryable failure must not quarantine'),
      },
      alerts: { poisonLogDetected: async () => assert.fail('retryable failure must not page') },
      logger: { error() {} },
    };
    await assert.rejects(processBatch(ctx, deps), (error) => error === original);
    fail = false;
    await processBatch(ctx, deps);
  });
}
