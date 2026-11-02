import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once as eventOnce } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { TradeStatus } from '@agroasys/sdk';
/* eslint-disable @typescript-eslint/no-require-imports */
const { dockerAvailable, withPostgresContainer } =
  require('../../../shared-db/postgres-test-support') as {
    dockerAvailable: boolean;
    withPostgresContainer: (fn: (value: { port: number }) => Promise<void>) => Promise<void>;
  };
/* eslint-enable @typescript-eslint/no-require-imports */
const local = process.env.RECONCILIATION_LOCAL_POSTGRES_TESTS === 'true';

test(
  'bounded independent cycles retain every identity and publish cumulative scope',
  { skip: !local && !dockerAvailable, timeout: 180000 },
  async (t) => {
    const run = async (port: number): Promise<void> => {
      const database = `recon_cycle_${randomBytes(6).toString('hex')}`;
      const cfg = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' };
      const admin = new Pool({ ...cfg, database: 'postgres' });
      let db: Pool | undefined;
      let close: (() => Promise<void>) | undefined;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        db = new Pool({ ...cfg, database, options: '-c app.service_name=reconciliation' });
        await runVersionedMigrations({
          pool: db,
          serviceName: 'reconciliation',
          manifestPath: path.resolve(__dirname, '../database/migrations.json'),
          runtimeDbUser: 'postgres',
        });
        Object.assign(process.env, {
          DB_NAME: database,
          DB_PORT: String(port),
          RECONCILIATION_MAX_TRADES_PER_RUN: '2',
          RECONCILIATION_BATCH_SIZE: '2',
          RECONCILIATION_INDEXER_ENUMERATION_LIMIT: '2',
          RECONCILIATION_INDEXER_ENUMERATION_PAGE_SIZE: '2',
        });
        const { OnchainClient } = await import('../blockchain/client');
        const { EscrowGovernanceReader } = await import('../blockchain/escrowGovernance');
        t.mock.method(EscrowGovernanceReader.prototype, 'isTradePaused', async () => true);
        const { ReconciliationService } = await import('../core/reconciler');
        close = (await import('../database/connection')).closeConnection;
        let height = 4242;
        let chainCounter = 1003;
        let records = Array.from({ length: 1003 }, (_, id) => ({
          id: `e${String(id).padStart(8, '0')}`,
          tradeId: String(id),
        }));
        const buyer = '0x1111111111111111111111111111111111111111';
        const supplier = '0x2222222222222222222222222222222222222222';
        const hash = `0x${'ab'.repeat(32)}`;
        let boundaryHash = hash;
        let changeAnchorOnCount = false;
        t.mock.method(OnchainClient.prototype, 'resolveBoundary', async () => ({
          blockNumber: height,
          blockHash: boundaryHash,
          tag: 'finalized' as const,
          chainTradeCounter: BigInt(chainCounter),
          indexerProcessedBlock: height,
          finalityBlockNumber: height,
          indexerAhead: false,
        }));
        t.mock.method(OnchainClient.prototype, 'getTrade', async (tradeId: string) => ({
          tradeId,
          buyer,
          supplier,
          status: TradeStatus.LOCKED,
          totalAmountLocked: 1000000n,
          logisticsAmount: 0n,
          platformFeesAmount: 0n,
          supplierFirstTranche: 600000n,
          supplierSecondTranche: 400000n,
          ricardianHash: hash,
          createdAt: new Date('2026-09-01T00:00:00Z'),
        }));
        let barrier: (() => Promise<void>) | undefined;
        const fetched: string[] = [];
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          const query = String(request.query);
          const vars = request.variables;
          let data: Record<string, unknown>;
          if (query.includes('ReconciliationIndexerProcessedBlock'))
            data = { overviewSnapshots: [{ lastProcessedBlock: String(height) }] };
          else if (query.includes('ReconciliationTradeIdUpperBound'))
            data = { tradeIds: records.slice(-1) };
          else if (query.includes('ReconciliationTradeCount')) {
            data = { tradesConnection: { totalCount: records.length } };
            if (changeAnchorOnCount) boundaryHash = `0x${'cd'.repeat(32)}`;
          } else if (query.includes('ReconciliationTradeIdsPage')) {
            assert.equal('offset' in vars, false);
            const page = records
              .filter((row) => row.id > vars.afterId && row.id <= vars.throughId)
              .slice(0, vars.limit);
            fetched.push(vars.afterId);
            if (barrier) await barrier();
            data = { tradeIds: page };
          } else if (query.includes('ReconciliationTradesByIds'))
            data = {
              trades: vars.tradeIds
                .filter((id: string) => records.some((row) => row.tradeId === id))
                .map((tradeId: string) => ({
                  tradeId,
                  buyer,
                  supplier,
                  status: 'LOCKED',
                  totalAmountLocked: '1000000',
                  logisticsAmount: '0',
                  platformFeesAmount: '0',
                  platformFeeNetAmount: '0',
                  settlementSupportFeeAmount: '0',
                  supplierFirstTranche: '600000',
                  supplierSecondTranche: '400000',
                  ricardianHash: hash,
                  createdAt: '2026-09-01T00:00:00Z',
                  arrivalTimestamp: null,
                })),
            };
          else throw new Error('Unexpected fixture query');
          return new Response(JSON.stringify({ data }), { status: 200 });
        });
        let sequence = 0;
        const service = new ReconciliationService();
        const once = () => service.reconcileOnce('ONCE', `cycle-${++sequence}`);

        await t.test(
          'more than 1000 physical rows are retained once and early scope survives the terminal page',
          async () => {
            let completed: Awaited<ReturnType<typeof once>> | undefined;
            for (let guard = 0; guard < 1010; guard++) {
              const result = await once();
              if (result.coverage?.complete) {
                completed = result;
                break;
              }
              assert.equal(result.coverage?.complete, false);
            }
            assert.ok(completed, 'cycle must finish without increasing either budget');
            assert.equal(completed.totalTrades, 1003);
            assert.equal(completed.driftCount, 0);
            const members = await db!.query(
              'SELECT count(*) AS count,count(DISTINCT physical_id) AS unique_count FROM reconcile_enumeration_members',
            );
            assert.deepEqual(members.rows, [{ count: '1003', unique_count: '1003' }]);
            const scope = await db!.query(
              'SELECT count(*) AS count,min(trade_id) AS first FROM reconcile_run_trades WHERE run_key=$1',
              [completed.runKey],
            );
            assert.equal(scope.rows[0].count, '1003');
            assert.equal(scope.rows[0].first, '0');
            assert.equal(
              (
                await db!.query(
                  "SELECT count(*) FROM reconcile_run_trades WHERE run_key=$1 AND trade_id='1002'",
                  [completed.runKey],
                )
              ).rows[0].count,
              '1',
            );
            assert.ok(fetched.includes('e00001001'));
            assert.equal(completed.coverage?.window.fromTradeId, 0n);
          },
        );

        await t.test(
          'a failed page publication rolls back progress and retry resumes the same generation',
          async () => {
            height++;
            chainCounter = 8;
            records = Array.from({ length: 8 }, (_, id) => ({
              id: `f${id}`,
              tradeId: id === 7 ? '999' : String(id),
            }));
            await db!
              .query(`CREATE FUNCTION fail_test_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected page failure'; END; $$;
          CREATE TRIGGER fail_test_page BEFORE INSERT ON reconcile_enumeration_members FOR EACH ROW EXECUTE FUNCTION fail_test_page()`);
            const key = `cycle-${sequence + 1}`;
            await assert.rejects(once(), /injected page failure/);
            const cycle = (
              await db!.query(
                'SELECT id,generation,after_id FROM reconcile_enumeration_cycles WHERE NOT finished',
              )
            ).rows[0];
            assert.equal(cycle.generation, '0');
            assert.equal(cycle.after_id, null);
            assert.equal(
              (
                await db!.query(
                  'SELECT count(*) FROM reconcile_enumeration_members WHERE cycle_id=$1',
                  [cycle.id],
                )
              ).rows[0].count,
              '0',
            );
            assert.equal(
              (await db!.query('SELECT count(*) FROM reconcile_run_trades WHERE run_key=$1', [key]))
                .rows[0].count,
              '0',
            );
            await db!.query(
              'DROP TRIGGER fail_test_page ON reconcile_enumeration_members; DROP FUNCTION fail_test_page()',
            );
            const retried = await new ReconciliationService().reconcileOnce('ONCE', key);
            assert.equal(retried.coverage?.complete, false);
            assert.equal(
              (
                await db!.query('SELECT after_id FROM reconcile_enumeration_cycles WHERE id=$1', [
                  cycle.id,
                ])
              ).rows[0].after_id,
              'f1',
            );
          },
        );

        await t.test(
          'a killed worker leaves visible unfinished work and its successor resumes the same page',
          async () => {
            const cycle = (
              await db!.query(
                'SELECT id,generation,after_id FROM reconcile_enumeration_cycles WHERE NOT finished',
              )
            ).rows[0];
            const child = fork(path.resolve(__dirname, 'helpers/enumerationCrashProcess.ts'), [], {
              execArgv: ['-r', 'ts-node/register'],
              cwd: path.resolve(__dirname, '../..'),
              env: { ...process.env, CRASH_TEST_HEIGHT: String(height) },
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
              stderr += String(chunk);
            });
            const exit = eventOnce(child, 'exit');
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                eventOnce(child, 'message').then(([message]) => {
                  assert.equal(message.event, 'PAGE_READ');
                  assert.equal(message.afterId, cycle.after_id);
                }),
                exit.then(() => {
                  throw new Error(`worker exited before page read: ${stderr}`);
                }),
                new Promise<never>((_resolve, reject) => {
                  deadline = setTimeout(() => reject(new Error('crash fixture timed out')), 15000);
                }),
              ]);
              child.kill('SIGKILL');
              assert.equal((await exit)[1], 'SIGKILL');
              const interrupted = (
                await db!.query("SELECT status FROM reconcile_runs WHERE run_key='crash-review'")
              ).rows[0];
              assert.equal(interrupted.status, 'RUNNING');
              assert.deepEqual(
                (
                  await db!.query(
                    'SELECT generation,after_id FROM reconcile_enumeration_cycles WHERE id=$1',
                    [cycle.id],
                  )
                ).rows[0],
                { generation: cycle.generation, after_id: cycle.after_id },
              );
              await db!.query(
                "UPDATE reconcile_runs SET lease_expires_at=NOW()-interval '1 second' WHERE run_key='crash-review'",
              );
              const retry = await service.reconcileOnce('ONCE', 'crash-review');
              assert.equal(retry.status, 'COMPLETED');
              assert.equal(
                (
                  await db!.query('SELECT after_id FROM reconcile_enumeration_cycles WHERE id=$1', [
                    cycle.id,
                  ])
                ).rows[0].after_id,
                'f3',
              );
              assert.equal(
                (
                  await db!.query(
                    "SELECT takeover_count FROM reconcile_runs WHERE run_key='crash-review'",
                  )
                ).rows[0].takeover_count,
                1,
              );
            } finally {
              if (deadline) clearTimeout(deadline);
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exit;
              }
            }
          },
        );
        await t.test('competing workers cannot both publish the same physical page', async () => {
          let arrived = 0;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          barrier = async () => {
            if (++arrived === 2) release();
            await gate;
          };
          const outcomes = await Promise.allSettled([once(), once()]);
          barrier = undefined;
          assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
          assert.equal(outcomes.filter((value) => value.status === 'rejected').length, 1);
          const cycle = (
            await db!.query(
              'SELECT id,after_id FROM reconcile_enumeration_cycles WHERE NOT finished',
            )
          ).rows[0];
          assert.equal(cycle.after_id, 'f5');
          assert.equal(
            (
              await db!.query(
                'SELECT count(*) FROM reconcile_enumeration_members WHERE cycle_id=$1',
                [cycle.id],
              )
            ).rows[0].count,
            '6',
          );
        });

        await t.test('tail surplus and missing records cannot cancel each other', async () => {
          for (let guard = 0; guard < 8; guard++)
            assert.equal((await once()).coverage?.complete, false);
          const findings = await db!.query(
            "SELECT DISTINCT trade_id,mismatch_code FROM reconcile_drifts WHERE trade_id IN ('7','999') ORDER BY trade_id",
          );
          assert.deepEqual(findings.rows, [
            { trade_id: '7', mismatch_code: 'INDEXER_TRADE_MISSING' },
            { trade_id: '999', mismatch_code: 'ONCHAIN_TRADE_MISSING' },
          ]);
          const cycle = (
            await db!.query(
              'SELECT after_id,walked FROM reconcile_enumeration_cycles WHERE NOT finished',
            )
          ).rows[0];
          assert.equal(cycle.after_id, 'f7');
          assert.equal(cycle.walked, '8');
        });

        await t.test(
          'source movement invalidates the old cycle and a fresh cycle rechecks all trades',
          async () => {
            height++;
            records = Array.from({ length: 8 }, (_, id) => ({ id: `g${id}`, tradeId: String(id) }));
            assert.equal((await once()).coverage?.complete, false);
            let completed = false;
            for (let guard = 0; guard < 12; guard++) {
              if ((await once()).coverage?.complete) {
                completed = true;
                break;
              }
            }
            assert.equal(completed, true);
          },
        );

        await t.test(
          'logical duplicates on different pages remain critical and incomplete',
          async () => {
            height++;
            chainCounter = 4;
            records = [
              { id: 'h0', tradeId: '0' },
              { id: 'h1', tradeId: '1' },
              { id: 'h2', tradeId: '2' },
              { id: 'h3', tradeId: '0' },
            ];
            assert.equal((await once()).coverage?.complete, false);
            const result = await once();
            assert.equal(result.coverage?.complete, false);
            const finding = await db!.query(
              "SELECT indexed_value FROM reconcile_drifts WHERE run_key=$1 AND mismatch_code='INDEXER_DUPLICATE_TRADE'",
              [result.runKey],
            );
            assert.deepEqual(finding.rows, [{ indexed_value: '2' }]);
            const alerts = await db!.query(
              "SELECT count(*) FROM reconcile_alert_outbox WHERE kind='CRITICAL_DRIFT' AND payload->'finding'->>'mismatchCode'='INDEXER_DUPLICATE_TRADE'",
            );
            assert.equal(Number(alerts.rows[0].count) > 0, true);
          },
        );
        await t.test(
          'a changed chain hash discards the page without advancing its generation',
          async () => {
            const before = (
              await db!.query(
                'SELECT id,generation FROM reconcile_enumeration_cycles WHERE NOT finished',
              )
            ).rows[0];
            changeAnchorOnCount = true;
            try {
              await assert.rejects(once(), /chain anchor changed before publication/);
            } finally {
              changeAnchorOnCount = false;
              boundaryHash = hash;
            }
            assert.equal(
              (
                await db!.query('SELECT generation FROM reconcile_enumeration_cycles WHERE id=$1', [
                  before.id,
                ])
              ).rows[0].generation,
              before.generation,
            );
          },
        );
        await t.test(
          'an empty source starts a fresh coherent cycle without fabricated members',
          async () => {
            height++;
            chainCounter = 0;
            records = [];
            assert.equal((await once()).coverage?.complete, false);
            const result = await once();
            assert.equal(result.coverage?.complete, true);
            assert.equal(result.totalTrades, 0);
            const cycle = (
              await db!.query(
                'SELECT walked,exhausted,upper_id FROM reconcile_enumeration_cycles WHERE id=$1',
                [result.coverage?.enumerationCycleId],
              )
            ).rows[0];
            assert.deepEqual(cycle, { walked: '0', exhausted: true, upper_id: null });
          },
        );
      } finally {
        await close?.();
        await db?.end();
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      }
    };
    if (local) await run(5432);
    else await withPostgresContainer(async ({ port }) => run(port));
  },
);
