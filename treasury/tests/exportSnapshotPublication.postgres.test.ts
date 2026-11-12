import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';

const describePostgres = process.env.TREASURY_POSTGRES_TESTS === 'true' ? describe : describe.skip;
describePostgres('snapshot evidence publication across databases', () => {
  const suffix = randomBytes(6).toString('hex');
  const treasuryName = `publication_t_${suffix}`;
  const reconciliationName = `publication_r_${suffix}`;
  const readerRole = `publication_reader_${suffix}`;
  const connection = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  const admin = new Pool({ ...connection, database: 'postgres' });
  let treasury: Pool;
  let reconciliation: Pool;
  let reader: Pool;
  let closeService: () => Promise<void>;
  let service: import('../src/core/reconciliationGate').ReconciliationGateService;
  let build: (
    key: string,
    mode?:
      | 'drift'
      | 'disabled'
      | 'ingestion'
      | 'ingestion-expiry'
      | 'reconciliation-expiry'
      | 'source-race',
  ) => Promise<boolean>;
  let nowOffset = 0;
  let reconciliationOffset = 0;
  const ingestionMaxAge = 900;
  let mutationRejected = false;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${treasuryName}"`);
    await admin.query(`CREATE DATABASE "${reconciliationName}"`);
    await admin.query(
      `CREATE ROLE "${readerRole}" LOGIN PASSWORD 'fixture-password' NOSUPERUSER NOBYPASSRLS`,
    );
    treasury = new Pool({
      ...connection,
      database: treasuryName,
      application_name: 'snapshot-publication-test',
      options: '-c app.service_name=treasury',
    });
    reconciliation = new Pool({
      ...connection,
      database: reconciliationName,
      options: '-c app.service_name=reconciliation',
    });
    for (const [pool, name] of [
      [treasury, 'treasury'],
      [reconciliation, 'reconciliation'],
    ] as const) {
      await runVersionedMigrations({
        pool,
        serviceName: name,
        manifestPath: path.resolve(__dirname, `../../${name}/src/database/migrations.json`),
        runtimeDbUser: 'postgres',
      });
    }
    await reconciliation.query(`GRANT USAGE ON SCHEMA public TO "${readerRole}"`);
    await reconciliation.query(
      `GRANT SELECT ON reconcile_runs, reconcile_run_trades, reconcile_drifts TO "${readerRole}"`,
    );
    reader = new Pool({
      ...connection,
      database: reconciliationName,
      user: readerRole,
      password: 'fixture-password',
      options: '-c app.service_name=reconciliation',
    });
    await treasury.query(`INSERT INTO treasury_ledger_entries (entry_key,trade_id,tx_hash,block_number,event_name,component_type,amount_raw,source_timestamp,created_at,canonicality_state)
      SELECT 'race-'||n,'trade-'||n,'tx-'||n,100,'fee','PLATFORM_FEE','42',TIMESTAMP '2000-01-01',TIMESTAMP '2000-01-01','ORPHANED' FROM generate_series(1,501) n`);
    await treasury.query(
      `UPDATE treasury_ingestion_state SET next_block_number=111,last_ingested_through_block_number=110,last_success_at=NOW() WHERE cursor_name IN ('trade_events','claim_events')`,
    );
    const run = await reconciliation.query(
      "INSERT INTO reconcile_runs (run_key,mode,status) VALUES ('published','ONCE','RUNNING') RETURNING id",
    );
    await reconciliation.query(
      "INSERT INTO reconcile_run_trades (run_id,run_key,trade_id) SELECT $1,'published','trade-'||n FROM generate_series(1,501) n",
      [run.rows[0].id],
    );
    await reconciliation.query(
      "UPDATE reconcile_runs SET status='COMPLETED',completed_at=NOW() AT TIME ZONE 'UTC',coverage_from_block=0,coverage_to_block=110,coverage_complete=true WHERE run_key='published'",
    );
    Object.assign(process.env, {
      PORT: '3200',
      DB_HOST: connection.host,
      DB_PORT: String(connection.port),
      DB_NAME: treasuryName,
      DB_USER: connection.user,
      DB_PASSWORD: connection.password,
      INDEXER_GRAPHQL_URL: 'http://127.0.0.1:3100/graphql',
    });
    const { ReconciliationGateService } = await import('../src/core/reconciliationGate');
    const { TreasuryEligibilityService } = await import('../src/core/exportEligibility');
    const { TreasuryIngestionFreshnessService } = await import('../src/core/ingestionFreshness');
    const { listIngestionCursorStates } = await import('../src/database/queries/ingestion');
    const { ExportSnapshotStore } = await import('../src/database/exportSnapshotStore');
    const { ExportSnapshotBuilder } = await import('../src/core/exportSnapshotBuilder');
    closeService = (await import('../src/database/connection')).closeConnection;
    service = new ReconciliationGateService({
      pool: reader,
      now: () => new Date(Date.now() + reconciliationOffset),
    });
    build = async (key, mode) => {
      let reads = 0;
      const eligibility = new TreasuryEligibilityService({
        provider: {
          getBlock: async (tag) => {
            const transactions = await treasury.query(
              "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='snapshot-publication-test' AND state='idle in transaction'",
            );
            expect(transactions.rows[0].count).toBe('0');
            return {
              number: tag === 'latest' ? 120 : tag === 'safe' ? 115 : 110,
              hash: `0x${'ab'.repeat(32)}`,
            };
          },
        },
        reconciliationGate: {
          snapshotRunAnchor: (selection) => service.snapshotRunAnchor(selection),
          assessTrades: async (ids, selection) => {
            const result = await service.assessTrades(ids, selection);
            if (++reads === 4) {
              if (mode === 'drift' || mode === 'disabled') {
                if (mode === 'disabled')
                  await reconciliation.query(
                    'ALTER TABLE reconcile_drifts DISABLE TRIGGER reconcile_published_child_guard',
                  );
                try {
                  await reconciliation.query(
                    "INSERT INTO reconcile_drifts (run_id,run_key,trade_id,severity,mismatch_code) SELECT id,run_key,'trade-501','CRITICAL','AMOUNT_MISMATCH' FROM reconcile_runs WHERE run_key='published'",
                  );
                } catch (error) {
                  mutationRejected =
                    (error as Error).message === 'reconcile_published_evidence_is_immutable';
                }
              }
              if (mode === 'ingestion')
                await treasury.query(
                  'UPDATE treasury_ingestion_state SET consecutive_failure_count=1',
                );
            }
            return result;
          },
        },
        ingestionFreshness: new TreasuryIngestionFreshnessService({
          reader: { listStates: (names) => listIngestionCursorStates(names, treasury) },
          now: () => new Date(Date.now() + nowOffset),
          maxAgeSeconds: ingestionMaxAge,
        }),
      });
      const verifyPublication = eligibility.verifyPublicationContext.bind(eligibility);
      eligibility.verifyPublicationContext = async (context, client) => {
        if (mode === 'ingestion-expiry') nowOffset = 901000;
        if (mode === 'reconciliation-expiry') reconciliationOffset = 901000;
        if (mode === 'source-race')
          await treasury.query('UPDATE treasury_ledger_entries SET trade_id=trade_id');
        await verifyPublication(context, client);
      };
      const store = new ExportSnapshotStore(treasury);
      const job = await store.create('publication-review', key, new Date('2001-01-01'));
      try {
        return await new ExportSnapshotBuilder(treasury, eligibility).build(job.id, 6000);
      } catch (error) {
        expect((await store.get('publication-review', job.id))?.status).toBe('FAILED');
        throw error;
      }
    };
  }, 60000);

  afterAll(async () => {
    await closeService?.();
    await reader?.end();
    await treasury?.end();
    await reconciliation?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${treasuryName}"`);
    await admin.query(`DROP DATABASE IF EXISTS "${reconciliationName}"`);
    await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
    await admin.end();
  });

  test('blocks a first-batch drift mutation while publishing 501 retained decisions', async () => {
    expect(await build('immutable', 'drift')).toBe(true);
    expect(mutationRejected).toBe(true);
    const result = await treasury.query(
      "SELECT count(*) FROM treasury_export_rows WHERE eligibility->'reconciliationEvidence'->>'status'='CLEAR'",
    );
    expect(result.rows[0].count).toBe('501');
  });

  test('fails when a publication guard is disabled after an earlier batch was checked', async () => {
    try {
      await expect(build('disabled', 'disabled')).rejects.toThrow(
        'Reconciliation evidence is unavailable or incomplete',
      );
    } finally {
      await reconciliation.query("DELETE FROM reconcile_drifts WHERE run_key='published'");
      await reconciliation.query(
        'ALTER TABLE reconcile_drifts ENABLE TRIGGER reconcile_published_child_guard',
      );
    }
  });

  test('rejects ingestion changes after the last per-batch freshness read', async () => {
    try {
      await expect(build('ingestion', 'ingestion')).rejects.toThrow(
        'Ingestion evidence changed or became stale',
      );
    } finally {
      await treasury.query('UPDATE treasury_ingestion_state SET consecutive_failure_count=0');
    }
  });

  test('never waits on a financial writer during publication', async () => {
    const writerPool = new Pool({ ...connection, database: treasuryName });
    const blocker = await writerPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE treasury_ledger_entries IN ROW EXCLUSIVE MODE');
      await expect(build('busy-writer')).rejects.toThrow(/could not obtain lock/);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await writerPool.end();
    }
  });
  test('rechecks ingestion age after the full source comparison', async () => {
    try {
      await expect(build('ingestion-expiry', 'ingestion-expiry')).rejects.toThrow(/stale/);
    } finally {
      nowOffset = 0;
    }
  });
  test('rechecks reconciliation age after the full source comparison', async () => {
    try {
      await expect(build('reconciliation-expiry', 'reconciliation-expiry')).rejects.toThrow(
        /stale|unavailable or incomplete/,
      );
    } finally {
      reconciliationOffset = 0;
    }
  });
  test('rejects a source write between the comparison and publication locks', async () => {
    await expect(build('source-race', 'source-race')).rejects.toThrow(
      'Captured ledger sources changed',
    );
  });
});
