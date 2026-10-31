import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ADDRESS = '0x00000000000000000000000000000000000000aa';
Object.assign(process.env, {
  COTSEL_ENVIRONMENT: 'local',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_NAME: 'indexer_test',
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_SSL_MODE: 'disable',
  RPC_ENDPOINT: 'http://127.0.0.1:18545',
  CHAIN_ID: '84532',
  START_BLOCK: '0',
  RATE_LIMIT: '1',
  FINALITY_CONFIRMATION_BLOCKS: '1',
  CONTRACT_ADDRESS: ADDRESS,
  NOTIFICATIONS_ENABLED: 'false',
});
const { processBatch } = require('../lib/main');
const { contractInterface } = require('../lib/abi');
const { PoisonLogHaltError } = require('../lib/poisonLog');
const { WebhookIndexerAlerts } = require('../lib/alerts');

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
function encodedLog(name) {
  const fragment = contractInterface.getEvent(name);
  const values = fragment.inputs.map((input) => {
    if (input.type === 'address') return ADDRESS;
    if (input.type === 'bool') return false;
    if (/^u?int/.test(input.type)) return 1n;
    if (input.type === 'bytes32') return '0x' + 'ab'.repeat(32);
    throw new Error(`Unexpected fixture type ${input.type}`);
  });
  return {
    ...contractInterface.encodeEventLog(fragment, values),
    address: ADDRESS,
    logIndex: 2,
    transactionIndex: 1,
    getTransaction: () => ({ hash: '0x' + 'cd'.repeat(32) }),
  };
}
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

const { QuarantineStore } = require('../lib/quarantine');
const Migration = require('../db/migrations/1785600000000-IndexerQuarantine.js');
const {
  dockerAvailable,
  withPostgresContainer,
  createAdminPool,
} = require('../../shared-db/postgres-test-support');

const localPostgres = process.env.INDEXER_POSTGRES_TESTS === 'true';
async function withTestPostgres(run) {
  if (!localPostgres) return withPostgresContainer(run);
  const { Pool } = require('pg');
  const admin = await createAdminPool(Number(process.env.INDEXER_TEST_POSTGRES_PORT || 5432));
  const schema = `indexer_parent_test_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await run({
      createPool: () => new Pool({ ...admin.options, options: `-c search_path=${schema}` }),
    });
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

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
