import { createRequire } from 'node:module';

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

export {
  require,
  ADDRESS,
  processBatch,
  contractInterface,
  PoisonLogHaltError,
  WebhookIndexerAlerts,
  encodedLog,
  QuarantineStore,
  Migration,
  dockerAvailable,
  localPostgres,
  withTestPostgres,
  createAdminPool,
};
