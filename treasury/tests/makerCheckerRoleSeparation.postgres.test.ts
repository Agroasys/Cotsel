/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-15 / PRES-05: two-person control over treasury transitions, decided
 * against the immutable actor chain rather than the mutable `*_by` columns.
 */
import { Pool } from 'pg';
import {
  applyTreasuryTestEnv,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';

type TreasuryQueries = typeof import('../src/database/queries');
type TreasuryConnection = typeof import('../src/database/connection');

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

describePostgres('treasury maker-checker role separation (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_roleseparation');
    cleanup = provisioned.cleanup;
    applyTreasuryTestEnv(provisioned.dbName);

    jest.resetModules();
    queries = await import('../src/database/queries');
    connection = await import('../src/database/connection');

    sidecar = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: provisioned.dbName,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  });

  afterAll(async () => {
    await sidecar?.end();
    await connection?.closeConnection();
    await cleanup?.();
  });

  async function seedPendingBatch(createdBy: string): Promise<number> {
    sequence += 1;
    const suffix = `rs-${sequence}`;

    const period = await queries.createAccountingPeriod({
      periodKey: `period-${suffix}`,
      startsAt: new Date('2026-04-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: 'finance-creator',
    });

    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `entry-${suffix}`,
      tradeId: `trade-${suffix}`,
      txHash: `0xrs${sequence}`,
      blockNumber: 900 + sequence,
      blockHash: `0x${(900 + sequence).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      logAddress: `0x${'11'.repeat(20)}`,
      logIdentityHash: 'a'.repeat(64),
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });

    const batch = await queries.createSweepBatch({
      batchKey: `batch-${suffix}`,
      accountingPeriodId: period.id,
      assetSymbol: 'USDC',
      expectedTotalRaw: '125000000',
      payoutReceiverAddress: '0xpayoutreceiver',
      createdBy,
    });

    await queries.addSweepBatchEntry({
      sweepBatchId: batch.id,
      ledgerEntryId: entry.id,
      allocatedBy: createdBy,
    });

    return batch.id;
  }

  it('records every accepted transition with its actor and role', async () => {
    const batchId = await seedPendingBatch('treasury-maker');

    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker',
    });
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'APPROVED',
      actor: 'treasury-checker',
    });

    const chain = await queries.listTransitionActorsForSubject('SWEEP_BATCH', batchId);
    expect(
      chain.map((record) => [
        record.from_status,
        record.to_status,
        record.actor,
        record.actor_role,
      ]),
    ).toEqual([
      ['DRAFT', 'PENDING_APPROVAL', 'treasury-maker', 'MAKER'],
      ['PENDING_APPROVAL', 'APPROVED', 'treasury-checker', 'CHECKER'],
    ]);
  });

  it('blocks a superseded preparer from approving the batch they prepared', async () => {
    const batchId = await seedPendingBatch('treasury-creator');

    // First maker prepares, the batch is sent back, a second maker re-prepares.
    // The `approval_requested_by` column now names only the second maker.
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker-one',
    });
    await queries.updateSweepBatchStatus({ batchId, status: 'DRAFT', actor: 'treasury-maker-one' });
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker-two',
    });

    const batch = await queries.getSweepBatchById(batchId);
    expect(batch?.approval_requested_by).toBe('treasury-maker-two');

    await expect(
      queries.updateSweepBatchStatus({
        batchId,
        status: 'APPROVED',
        actor: 'treasury-maker-one',
      }),
    ).rejects.toThrow('Sweep batch approval requires a different actor than preparation');

    expect((await queries.getSweepBatchById(batchId))?.status).toBe('PENDING_APPROVAL');
  });

  it('blocks the actor who requested a period close from granting it', async () => {
    sequence += 1;
    const period = await queries.createAccountingPeriod({
      periodKey: `period-sod-${sequence}`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-04-01T00:00:00.000Z'),
      createdBy: 'finance-creator',
    });

    await queries.updateAccountingPeriodStatus({
      periodId: period.id,
      status: 'PENDING_CLOSE',
      actor: 'finance-maker',
      closeReason: 'quarter end',
    });

    await expect(
      queries.updateAccountingPeriodStatus({
        periodId: period.id,
        status: 'CLOSED',
        actor: 'finance-maker',
      }),
    ).rejects.toThrow(/different actor than the close request/);

    await expect(
      queries.updateAccountingPeriodStatus({
        periodId: period.id,
        status: 'CLOSED',
        actor: 'finance-checker',
      }),
    ).resolves.toMatchObject({ status: 'CLOSED', closed_by: 'finance-checker' });
  });

  it('refuses to rewrite or erase a recorded transition', async () => {
    const batchId = await seedPendingBatch('treasury-maker');
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker',
    });

    await expect(
      sidecar.query(
        `UPDATE treasury_transition_actors SET actor = 'someone-else'
         WHERE subject_type = 'SWEEP_BATCH' AND subject_id = $1`,
        [batchId],
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      sidecar.query(
        `DELETE FROM treasury_transition_actors
         WHERE subject_type = 'SWEEP_BATCH' AND subject_id = $1`,
        [batchId],
      ),
    ).rejects.toThrow(/append-only/);

    const chain = await queries.listTransitionActorsForSubject('SWEEP_BATCH', batchId);
    expect(chain).toHaveLength(1);
    expect(chain[0].actor).toBe('treasury-maker');
  });

  it('leaves no transition record behind when the transition is rejected', async () => {
    const batchId = await seedPendingBatch('treasury-maker');
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker',
    });

    await expect(
      queries.updateSweepBatchStatus({ batchId, status: 'APPROVED', actor: 'treasury-maker' }),
    ).rejects.toThrow(/different actor than preparation/);

    const chain = await queries.listTransitionActorsForSubject('SWEEP_BATCH', batchId);
    expect(chain.filter((record) => record.to_status === 'APPROVED')).toHaveLength(0);
  });
});
