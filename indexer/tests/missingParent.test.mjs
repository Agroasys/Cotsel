import {
  require,
  processBatch,
  PoisonLogHaltError,
  WebhookIndexerAlerts,
  encodedLog,
  QuarantineStore,
  Migration,
  dockerAvailable,
  localPostgres,
  withTestPostgres,
  createAdminPool,
} from './batchFixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const eventNames = [
  'FundsReleasedStage1',
  'PlatformFeesPaidStage1',
  'InspectionAvailable',
  'InspectionAcceptedForFinalRelease',
  'FinalTrancheReleased',
  'DisputeOpenedByBuyer',
  'TradePaused',
  'TradeUnpaused',
  'TradeCancelledAfterLockTimeout',
  'InTransitTimeoutRefunded',
  'RelayedActionExecuted',
  'GaslessTradeFunded',
  'SupplierPayoutTransferred',
  'BuyerRefundTransferred',
  'DisputeSolutionProposed',
  'DisputePayout',
  'ClaimableAccrued',
  'OracleUpdateApproved',
  'OracleUpdateProposalExpiredCancelled',
  'AdminChangeApproved',
  'AdminChangeExecuted',
  'AdminChangeProposalCancelled',
  'DisputeApproved',
  'DisputeFinalized',
  'DisputeProposalExpiredCancelled',
];
for (const name of eventNames) {
  test(`${name} with a missing parent halts before persistence and raises a critical alert`, async () => {
    const raw = encodedLog(name);
    const quarantine = [];
    const alerts = [];
    const writes = [];
    const ctx = {
      blocks: [{ header: { height: 4242, hash: '0xblock', timestamp: 1000 }, logs: [raw] }],
      store: {
        get: async (model) => (model.name === 'OverviewSnapshot' ? {} : undefined),
        upsert: async (rows) => writes.push(rows),
      },
      log: { info() {}, error() {} },
    };
    await assert.rejects(
      processBatch(ctx, {
        quarantine: { recordPoisonLog: async (entry) => quarantine.push(entry) },
        alerts: new WebhookIndexerAlerts({ notify: async (entry) => alerts.push(entry) }),
        logger: { error() {} },
      }),
      (error) => error instanceof PoisonLogHaltError && error.entry.reason === 'HANDLER_FAILURE',
    );
    assert.equal(writes.length, 0);
    assert.equal(quarantine.length, 1);
    assert.equal(quarantine[0].eventName, name);
    assert.deepEqual(quarantine[0].topics, raw.topics);
    assert.equal(quarantine[0].data, raw.data);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'critical');
  });
}

test('the same claim log projects after its parent is restored', async () => {
  const raw = encodedLog('ClaimableAccrued');
  const writes = [];
  const parent = { id: '1' };
  const ctx = {
    blocks: [{ header: { height: 4242, hash: '0xblock', timestamp: 1000 }, logs: [raw] }],
    store: {
      get: async (model) => (model.name === 'OverviewSnapshot' ? {} : parent),
      upsert: async (rows) => writes.push(...rows),
    },
    log: { info() {}, error() {} },
  };
  const deps = {
    quarantine: { recordPoisonLog: async () => assert.fail('unexpected quarantine') },
    alerts: { poisonLogDetected: async () => assert.fail('unexpected alert') },
    logger: { error() {} },
  };
  await processBatch(ctx, deps);
  const first = writes.find((row) => row.eventName === 'ClaimableAccrued');
  assert.equal(first.trade.id, '1');
  assert.equal(first.claimAmount, 1n);
  assert.equal(first.txHash, raw.getTransaction().hash);
  writes.length = 0;
  await processBatch(ctx, deps);
  assert.deepEqual(
    writes.find((row) => row.eventName === 'ClaimableAccrued'),
    first,
  );
});

test(
  'missing-parent batch quarantine survives PostgreSQL rollback',
  { skip: !dockerAvailable && !localPostgres, timeout: 180000 },
  async () => {
    await withTestPostgres(async ({ port, createPool }) => {
      const pool = createPool ? createPool() : await createAdminPool(port);
      const quarantinePool = createPool ? createPool() : await createAdminPool(port);
      let batch;
      try {
        await new Migration().up({ query: (sql, params) => pool.query(sql, params) });
        await pool.query('CREATE TABLE checkpoint (height integer NOT NULL)');
        await pool.query('INSERT INTO checkpoint VALUES (4241)');
        batch = await pool.connect();
        await batch.query('BEGIN');
        await batch.query('UPDATE checkpoint SET height = 4242');
        const raw = encodedLog('ClaimableAccrued');
        const ctx = {
          blocks: [{ header: { height: 4242, hash: '0xblock', timestamp: 1000 }, logs: [raw] }],
          store: {
            get: async (model) => (model.name === 'OverviewSnapshot' ? {} : undefined),
            upsert: async () => assert.fail('missing-parent batch must not persist'),
          },
          log: { info() {}, error() {} },
        };
        await assert.rejects(
          processBatch(ctx, {
            quarantine: new QuarantineStore(quarantinePool),
            alerts: { poisonLogDetected: async () => {} },
            logger: { error() {} },
          }),
          PoisonLogHaltError,
        );
        await batch.query('ROLLBACK');
        const result = await pool.query('SELECT * FROM indexer_quarantined_log');
        assert.equal(result.rows.length, 1);
        assert.deepEqual(result.rows[0].topics, raw.topics);
        assert.equal(result.rows[0].data, raw.data);
        assert.equal(result.rows[0].reason, 'HANDLER_FAILURE');
        assert.equal(result.rows[0].status, 'UNRESOLVED');
        assert.equal((await pool.query('SELECT height FROM checkpoint')).rows[0].height, 4241);
      } finally {
        if (batch) {
          await batch.query('ROLLBACK');
          batch.release();
        }
        await quarantinePool.end();
        await pool.end();
      }
    });
  },
);

test('an out-of-order child halts, and corrected parent-first replay projects both logs', async () => {
  const { createEmptyOverviewCounters } = require('../lib/overviewAggregate');
  const child = encodedLog('ClaimableAccrued');
  const parent = { ...encodedLog('TradeLocked'), logIndex: 1 };
  const writes = [];
  const quarantined = [];
  const ctx = {
    blocks: [{ header: { height: 4242, hash: '0xblock', timestamp: 1000 }, logs: [child, parent] }],
    store: {
      get: async (model) =>
        model.name === 'OverviewSnapshot' ? createEmptyOverviewCounters() : undefined,
      upsert: async (rows) => writes.push(...rows),
    },
    log: { info() {}, error() {} },
  };
  const deps = {
    quarantine: { recordPoisonLog: async (entry) => quarantined.push(entry) },
    alerts: { poisonLogDetected: async () => {} },
    logger: { error() {} },
  };
  await assert.rejects(processBatch(ctx, deps), PoisonLogHaltError);
  assert.equal(writes.length, 0);
  assert.equal(quarantined[0].eventName, 'ClaimableAccrued');
  ctx.blocks[0].logs = [parent, child];
  await processBatch(ctx, deps);
  const events = writes.filter((row) => row.eventName);
  assert.deepEqual(
    events.map((row) => row.eventName),
    ['TradeLocked', 'ClaimableAccrued'],
  );
  assert.equal(events[1].trade.id, events[0].trade.id);
  assert.equal(events[1].claimAmount, 1n);
  assert.equal(writes.find((row) => row.totalTrades !== undefined).totalTrades, 1);
});

for (const fault of ['undecodable', 'handler-exception']) {
  test(`${fault} through the batch handler preserves the raw log and halts`, async () => {
    const raw = encodedLog('ClaimableAccrued');
    if (fault === 'undecodable') raw.data = '0x';
    const quarantined = [];
    const alerts = [];
    const ctx = {
      blocks: [{ header: { height: 4242, hash: '0xblock', timestamp: 1000 }, logs: [raw] }],
      store: {
        get: async (model) => {
          if (model.name === 'OverviewSnapshot') return {};
          throw new Error('injected handler store failure');
        },
        upsert: async () => assert.fail('faulted batch must not persist'),
      },
      log: { info() {}, error() {} },
    };
    await assert.rejects(
      processBatch(ctx, {
        quarantine: { recordPoisonLog: async (entry) => quarantined.push(entry) },
        alerts: new WebhookIndexerAlerts({ notify: async (entry) => alerts.push(entry) }),
        logger: { error() {} },
      }),
      PoisonLogHaltError,
    );
    assert.equal(quarantined.length, 1);
    assert.equal(
      quarantined[0].reason,
      fault === 'undecodable' ? 'UNDECODABLE' : 'HANDLER_FAILURE',
    );
    assert.equal(quarantined[0].data, raw.data);
    assert.deepEqual(quarantined[0].topics, raw.topics);
    assert.equal(alerts[0].severity, 'critical');
  });
}
