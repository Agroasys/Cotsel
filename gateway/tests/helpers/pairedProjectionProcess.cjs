/** SPDX-License-Identifier: Apache-2.0 */
// Opt-in local test process. Runs retained indexer/GraphQL/reconciliation against disposable databases.
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const fromIndexer = createRequire(path.join(root, 'indexer/package.json'));
const { Pool } = fromIndexer('pg');
const children = [],
  pools = [],
  databases = [],
  roles = [];
let runtime;
let closed = false;
const send = (value) => process.send?.(value);
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function start(file, args, cwd, env) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  // Logs stay in this process's pipe. Never include provider credentials or signatures in IPC.
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
}
async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}
async function wait(check, message) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (children.some((c) => c.exitCode !== null || c.signalCode !== null))
      throw new Error('Retained projection process exited');
    try {
      if (await check()) return;
    } catch {
      /* startup is bounded */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function close() {
  if (closed) return;
  closed = true;
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGCONT');
      child.kill('SIGTERM');
    }
  await Promise.all(children.map(exited));
  await Promise.all(pools.map((pool) => pool.end()));
  const admin = new Pool({
    connectionString: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  });
  try {
    for (const name of databases)
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    for (const name of roles) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
async function initialize(input) {
  if (
    !process.send ||
    process.env.COTSEL_PAIRED_LIFECYCLE_FIXTURE !== 'true' ||
    input.rpcUrls.length !== 2 ||
    input.rpcUrls.some((value) => !['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) ||
    !/^0x[0-9a-f]{40}$/.test(input.escrowAddress) ||
    !/^0x[0-9a-f]{40}$/.test(input.tokenAddress)
  )
    throw new Error('Explicit loopback projection fixture required');
  const suffix = randomBytes(6).toString('hex');
  const indexerDb = `rev2_indexer_${suffix}`,
    reconDb = `rev2_recon_${suffix}`;
  const indexerRole = `rev2_indexer_app_${suffix}`,
    reconRole = `rev2_recon_app_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({
    connectionString: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  });
  try {
    for (const name of [indexerRole, reconRole]) {
      await admin.query(
        `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      roles.push(name);
      await admin.query(`ALTER ROLE "${name}" SET TimeZone='UTC'`);
    }
    for (const name of [indexerDb, reconDb]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      databases.push(name);
    }
  } finally {
    await admin.end();
  }
  const indexerPool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: indexerDb,
    user: 'postgres',
    password: 'postgres',
  });
  pools.push(indexerPool);
  const reconAdmin = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: reconDb,
    user: 'postgres',
    password: 'postgres',
    options: `-c app.service_name=reconciliation -c app.runtime_db_user=${reconRole} -c TimeZone=UTC`,
  });
  pools.push(reconAdmin);
  const common = {
    ...process.env,
    NODE_ENV: 'test',
    COTSEL_ENVIRONMENT: 'local',
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_PASSWORD: password,
    CHAIN_ID: '84532',
    ESCROW_ADDRESS: input.escrowAddress,
    USDC_ADDRESS: input.tokenAddress,
    NOTIFICATIONS_ENABLED: 'false',
    NOTIFICATIONS_WEBHOOK_URL: '',
    RPC_ENDPOINT: input.rpcUrls[0],
    RPC_URL: input.rpcUrls[0],
    RPC_FALLBACK_ENDPOINTS: input.rpcUrls[1],
    RPC_FALLBACK_URLS: input.rpcUrls[1],
    DB_SSL_MODE: 'disable',
    GATEWAY_URL: '',
    CONTRACT_ADDRESS: input.escrowAddress,
    START_BLOCK: '0',
    RATE_LIMIT: '100',
    RPC_CAPACITY: '10',
    FINALITY_CONFIRMATION_BLOCKS: '64',
    RPC_HEAD_POLL_INTERVAL_MS: '100',
    VERIFY_START_BLOCK_CODE: 'false',
    PGOPTIONS: '-c TimeZone=UTC',
  };
  const indexerEnv = {
    ...common,
    DB_NAME: indexerDb,
    DB_USER: indexerRole,
    READINESS_PORT: String(await port()),
  };
  const migration = spawn(process.execPath, ['migrate.js'], {
    cwd: path.join(root, 'indexer'),
    env: { ...indexerEnv, DB_USER: 'postgres', DB_PASSWORD: 'postgres' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  migration.stdout.pipe(process.stdout);
  migration.stderr.pipe(process.stderr);
  if ((await exited(migration)) !== 0) throw new Error('Retained indexer migrations failed');
  await indexerPool.query(`GRANT USAGE ON SCHEMA public,squid_processor TO "${indexerRole}"`);
  await indexerPool.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,squid_processor TO "${indexerRole}"`,
  );
  await indexerPool.query(
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,squid_processor TO "${indexerRole}"`,
  );
  const { runVersionedMigrations } = require(path.join(root, 'shared-db/migrate'));
  await runVersionedMigrations({
    pool: reconAdmin,
    serviceName: 'reconciliation',
    manifestPath: path.join(root, 'reconciliation/src/database/migrations.json'),
    runtimeDbUser: reconRole,
  });
  const indexerProcess = start(
    path.join(root, 'indexer/tests/pairedFinalizedProcess.cjs'),
    [],
    path.join(root, 'indexer'),
    indexerEnv,
  );
  const graphqlPort = await port();
  start(
    path.join(
      path.dirname(fromIndexer.resolve('@subsquid/graphql-server/package.json')),
      'bin/run.js',
    ),
    [],
    path.join(root, 'indexer'),
    { ...indexerEnv, GQL_PORT: String(graphqlPort) },
  );
  const graphqlUrl = `http://127.0.0.1:${graphqlPort}/graphql`;
  await wait(
    async () =>
      (
        await fetch(graphqlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ tradesConnection(orderBy:id_ASC) { totalCount } }' }),
        })
      ).ok,
    'GraphQL startup timeout',
  );
  runtime = {
    indexerProcess,
    indexerPool,
    reconAdmin,
    graphqlUrl,
    indexerEnv,
    common,
    reconDb,
    reconRole,
    password,
  };
  return { event: 'ready', indexerUrl: `http://127.0.0.1:${indexerEnv.READINESS_PORT}/coverage` };
}
async function project(input) {
  if (!runtime || !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0)
    throw new Error('Projection scope required');
  await wait(async () => {
    const r = await runtime.indexerPool.query(
      'SELECT height FROM squid_processor.status WHERE id=0',
    );
    const o = await runtime.indexerPool.query(
      'SELECT last_processed_block FROM overview_snapshot LIMIT 1',
    );
    return (
      r.rows[0]?.height >= input.blockNumber &&
      BigInt(o.rows[0]?.last_processed_block ?? -1) >= BigInt(input.blockNumber)
    );
  }, 'Actual indexer checkpoint did not cover receipt');
  const runKey = `paired-projection-${randomBytes(10).toString('hex')}`;
  const child = spawn(process.execPath, ['dist/cli.js', 'once', `--run-key=${runKey}`], {
    cwd: path.join(root, 'reconciliation'),
    env: {
      ...runtime.common,
      DB_NAME: runtime.reconDb,
      DB_USER: runtime.reconRole,
      INDEXER_GRAPHQL_URL: runtime.graphqlUrl,
      RECONCILIATION_COVERAGE_BOUNDARY: 'finalized',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  if ((await exited(child)) !== 0) throw new Error('Retained reconciliation process failed');
  const run = await runtime.reconAdmin.query(
    'SELECT status,drift_count,coverage_complete,chain_evidence FROM reconcile_runs WHERE run_key=$1',
    [runKey],
  );
  if (
    run.rows[0]?.status !== 'COMPLETED' ||
    run.rows[0]?.drift_count !== 0 ||
    !run.rows[0]?.coverage_complete
  )
    throw new Error('Actual reconciliation coverage incomplete');
  const fromRecon = createRequire(path.join(root, 'reconciliation/package.json'));
  const { readFinancialCoverage } = fromRecon('./dist/core/financialCoverage');
  const coverage = await readFinancialCoverage(
    runtime.reconAdmin,
    '0',
    String(input.finalizedBlockNumber),
    3600000,
  );
  if (!coverage) {
    const debug = await runtime.reconAdmin.query(
      "SELECT completed_at,completed_at AT TIME ZONE 'UTC' AS utc,coverage_to_block,chain_evidence,current_setting('TimeZone') AS timezone,NOW() AS now FROM reconcile_runs WHERE run_key=$1",
      [runKey],
    );
    throw new Error('Actual financial coverage unavailable ' + JSON.stringify(debug.rows));
  }
  const checkpoint = await runtime.indexerPool.query(
    'SELECT height,hash FROM squid_processor.status WHERE id=0',
  );
  return {
    event: 'projected',
    coverage: {
      version: 'cotsel.financial-projection-coverage.v1',
      tradeId: '0',
      indexer: {
        blockNumber: String(checkpoint.rows[0].height),
        blockHash: checkpoint.rows[0].hash,
      },
      reconciliation: {
        runKey: coverage.runKey,
        blockNumber: coverage.evidence.blockNumber,
        blockHash: coverage.evidence.blockHash,
        verifiedAt: coverage.verifiedAt,
      },
    },
  };
}
let queue = Promise.resolve();
process.on('message', (input) => {
  queue = queue.then(async () => {
    try {
      if (input.command === 'start') send(await initialize(input));
      else if (input.command === 'project') send(await project(input));
      else if (input.command === 'close') {
        await close();
        send({ event: 'closed' });
        process.disconnect();
      } else throw new Error('Unsupported projection command');
    } catch (error) {
      process.stderr.write(String(error.stack) + '\n');
      send({ event: 'failed' });
    }
  });
});
process.once('disconnect', () => {
  void close().finally(() => process.exit());
});
