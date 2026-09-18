/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-15: concurrency safety for treasury maker-checker transitions.
 *
 * A single-connection test cannot observe a lost update, so every case here
 * drives two real connections against a real PostgreSQL instance and asserts
 * that exactly one of a conflicting pair commits and that one immutable actor
 * chain remains behind it.
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

describePostgres('treasury maker-checker concurrency (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_makerchecker');
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

  async function seedApprovableBatch(): Promise<{ batchId: number; periodId: number }> {
    sequence += 1;
    const suffix = `mc-${sequence}`;

    const period = await queries.createAccountingPeriod({
      periodKey: `period-${suffix}`,
      startsAt: new Date('2026-04-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: 'finance-maker',
    });

    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `entry-${suffix}`,
      tradeId: `trade-${suffix}`,
      txHash: `0xhash${sequence}`,
      blockNumber: 100 + sequence,
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
      createdBy: 'treasury-maker',
    });

    await queries.addSweepBatchEntry({
      sweepBatchId: batch.id,
      ledgerEntryId: entry.id,
      allocatedBy: 'treasury-maker',
    });

    await queries.updateSweepBatchStatus({
      batchId: batch.id,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker',
    });

    return { batchId: batch.id, periodId: period.id };
  }

  async function seedLedgerEntryId(): Promise<number> {
    sequence += 1;
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `entry-alloc-${sequence}`,
      tradeId: `trade-alloc-${sequence}`,
      txHash: `0xalloc${sequence}`,
      blockNumber: 700 + sequence,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });
    return entry.id;
  }

  async function seedDraftBatch(): Promise<{ batchId: number; periodId: number }> {
    sequence += 1;
    const suffix = `alloc-${sequence}`;

    const period = await queries.createAccountingPeriod({
      periodKey: `period-${suffix}`,
      startsAt: new Date('2026-04-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: 'finance-maker',
    });

    const batch = await queries.createSweepBatch({
      batchKey: `batch-${suffix}`,
      accountingPeriodId: period.id,
      assetSymbol: 'USDC',
      expectedTotalRaw: '125000000',
      payoutReceiverAddress: '0xpayoutreceiver',
      createdBy: 'treasury-maker',
    });

    return { batchId: batch.id, periodId: period.id };
  }

  function settle<T>(promise: Promise<T>): Promise<{ ok: boolean; error?: Error }> {
    return promise.then(
      () => ({ ok: true }),
      (error: Error) => ({ ok: false, error }),
    );
  }

  it('lets exactly one of two concurrent approvers win, and records only that approver', async () => {
    const { batchId } = await seedApprovableBatch();

    const [first, second] = await Promise.all([
      settle(
        queries.updateSweepBatchStatus({
          batchId,
          status: 'APPROVED',
          actor: 'treasury-checker-a',
        }),
      ),
      settle(
        queries.updateSweepBatchStatus({
          batchId,
          status: 'APPROVED',
          actor: 'treasury-checker-b',
        }),
      ),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const batch = await queries.getSweepBatchById(batchId);
    expect(batch?.status).toBe('APPROVED');
    expect(['treasury-checker-a', 'treasury-checker-b']).toContain(batch?.approved_by);

    // One approval, one approver: the loser left nothing behind.
    const chain = await queries.listTransitionActorsForSubject('SWEEP_BATCH', batchId);
    const approvals = chain.filter((record) => record.to_status === 'APPROVED');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actor).toBe(batch?.approved_by);
    expect(approvals[0].actor_role).toBe('CHECKER');
  });

  it('rejects a transition whose state was changed by another writer while it waited', async () => {
    const { batchId } = await seedApprovableBatch();

    // Hold the row so the approval below blocks on the lock rather than racing
    // it, then move the batch out from under the waiting approver.
    const holder = await sidecar.connect();
    let approval: Promise<{ ok: boolean; error?: Error }>;

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM sweep_batches WHERE id = $1 FOR UPDATE', [batchId]);

      approval = settle(
        queries.updateSweepBatchStatus({
          batchId,
          status: 'APPROVED',
          actor: 'treasury-checker-a',
        }),
      );

      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
      await holder.query(`UPDATE sweep_batches SET status = 'VOID' WHERE id = $1`, [batchId]);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const result = await approval;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Invalid sweep batch transition: VOID -> APPROVED/);

    const batch = await queries.getSweepBatchById(batchId);
    expect(batch?.status).toBe('VOID');
    expect(batch?.approved_by).toBeNull();
  });

  it('lets exactly one of two concurrent period closes win', async () => {
    sequence += 1;
    const period = await queries.createAccountingPeriod({
      periodKey: `period-close-${sequence}`,
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

    const [first, second] = await Promise.all([
      settle(
        queries.updateAccountingPeriodStatus({
          periodId: period.id,
          status: 'CLOSED',
          actor: 'finance-checker-a',
        }),
      ),
      settle(
        queries.updateAccountingPeriodStatus({
          periodId: period.id,
          status: 'CLOSED',
          actor: 'finance-checker-b',
        }),
      ),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const closed = await queries.getAccountingPeriodById(period.id);
    expect(closed?.status).toBe('CLOSED');

    const chain = await queries.listTransitionActorsForSubject('ACCOUNTING_PERIOD', period.id);
    const closes = chain.filter((record) => record.to_status === 'CLOSED');
    expect(closes).toHaveLength(1);
    expect(closes[0].actor).toBe(closed?.closed_by);
  });

  it('makes an allocation lose once a period close has started', async () => {
    const { batchId, periodId } = await seedDraftBatch();

    // Hold the accounting period the way `updateAccountingPeriodStatus` does,
    // so the allocation below queues behind the close rather than racing it.
    const holder = await sidecar.connect();
    let allocation: Promise<{ ok: boolean; error?: Error }>;

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM accounting_periods WHERE id = $1 FOR UPDATE', [periodId]);

      allocation = settle(
        queries.addSweepBatchEntry({
          sweepBatchId: batchId,
          ledgerEntryId: await seedLedgerEntryId(),
          allocatedBy: 'treasury-maker',
        }),
      );

      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
      await holder.query(`UPDATE accounting_periods SET status = 'PENDING_CLOSE' WHERE id = $1`, [
        periodId,
      ]);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const result = await allocation;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(
      /requires an OPEN accounting period; received PENDING_CLOSE/,
    );

    // The decisive assertion: nothing was stranded in a period that is closing.
    const stranded = await sidecar.query(
      `SELECT COUNT(*)::int AS count
       FROM sweep_batch_entries e
       JOIN sweep_batches b ON b.id = e.sweep_batch_id
       JOIN accounting_periods p ON p.id = b.accounting_period_id
       WHERE p.status <> 'OPEN'`,
    );
    expect(stranded.rows[0].count).toBe(0);
  });

  it('records exactly one bank confirmation when the same reference arrives twice at once', async () => {
    sequence += 1;
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `entry-bank-${sequence}`,
      tradeId: `trade-bank-${sequence}`,
      txHash: `0xbank${sequence}`,
      blockNumber: 500 + sequence,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });

    await queries.appendPayoutState({
      ledgerEntryId: entry.id,
      state: 'AWAITING_EXTERNAL_CONFIRMATION',
      actor: 'treasury-operator',
    });

    const confirmation = {
      ledgerEntryId: entry.id,
      payoutReference: `payout-${sequence}`,
      bankReference: `bank-ref-${sequence}`,
      bankState: 'CONFIRMED' as const,
      confirmedAt: new Date('2026-04-17T08:00:00.000Z'),
      source: 'provider-webhook',
      actor: 'service:treasury-gateway',
      failureCode: null,
      evidenceReference: `evidence-${sequence}`,
      metadata: {},
    };

    const [first, second] = await Promise.all([
      settle(queries.upsertBankPayoutConfirmation(confirmation)),
      settle(queries.upsertBankPayoutConfirmation(confirmation)),
    ]);

    // Both callers may legitimately succeed here: one creates, the other is an
    // idempotent replay of the identical payload. What must not happen is two
    // stored confirmations for one bank reference.
    expect(first.error ?? second.error).toBeUndefined();

    const stored = await sidecar.query(
      `SELECT COUNT(*)::int AS count FROM bank_payout_confirmations WHERE bank_reference = $1`,
      [confirmation.bankReference],
    );
    expect(stored.rows[0].count).toBe(1);
  });
});
