/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / PRES-05: the sweep batch path refuses a ledger entry the chain
 * no longer contains, checked inside the transaction that writes the decision.
 * The controller re-derives the verdict first; this suite proves the database
 * half holds on its own, including against an orphaning that commits while the
 * decision is waiting on it.
 */
import { Pool } from 'pg';
import type { LedgerEntry } from '../src/types';
import {
  applyTreasuryTestEnv,
  markSeededEntryCanonical,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';

type TreasuryQueries = typeof import('../src/database/queries');
type TreasuryConnection = typeof import('../src/database/connection');

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

describePostgres('treasury sweep canonicality gate (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_sweepcanonicality');
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

  async function seedEntry(): Promise<LedgerEntry> {
    sequence += 1;
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `entry-sc-${sequence}`,
      tradeId: `trade-sc-${sequence}`,
      txHash: `0xsc${sequence}`,
      blockNumber: 300 + sequence,
      blockHash: `0x${(300 + sequence).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      logAddress: `0x${'11'.repeat(20)}`,
      logIdentityHash: 'a'.repeat(64),
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });
    return entry;
  }

  async function seedDraftBatch(): Promise<number> {
    sequence += 1;
    const period = await queries.createAccountingPeriod({
      periodKey: `period-sc-${sequence}`,
      startsAt: new Date('2026-04-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: 'finance-creator',
    });
    const batch = await queries.createSweepBatch({
      batchKey: `batch-sc-${sequence}`,
      accountingPeriodId: period.id,
      assetSymbol: 'USDC',
      expectedTotalRaw: '125000000',
      payoutReceiverAddress: '0xpayoutreceiver',
      createdBy: 'treasury-maker',
    });
    return batch.id;
  }

  async function orphan(entry: LedgerEntry): Promise<void> {
    await queries.recordLedgerEntryOrphaned({
      ledgerEntryId: entry.id,
      entryKey: entry.entry_key,
      tradeId: entry.trade_id,
      txHash: entry.tx_hash,
      blockNumber: entry.block_number,
      expectedBlockHash: entry.block_hash,
      observedBlockHash: `0x${'cd'.repeat(32)}`,
      observedBlockNumber: entry.block_number,
      observedLogIndex: 0,
      reorgDepth: 3,
      stableBlockNumber: entry.block_number + 64,
      mismatchReason: 'BLOCK_HASH_MISMATCH',
      detail: 'test reorganization',
      cancelFromState: null,
      actor: 'system:chain-canonicality',
    });
  }

  async function allocationCount(batchId: number): Promise<number> {
    const result = await sidecar.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM sweep_batch_entries WHERE sweep_batch_id = $1',
      [batchId],
    );
    return result.rows[0].count;
  }

  it('refuses to allocate an entry whose canonicality was never proven', async () => {
    const batchId = await seedDraftBatch();
    const entry = await seedEntry();

    await expect(
      queries.addSweepBatchEntry({
        sweepBatchId: batchId,
        ledgerEntryId: entry.id,
        allocatedBy: 'treasury-maker',
      }),
    ).rejects.toThrow(`not proven canonical: ${entry.id} (UNVERIFIED)`);
    expect(await allocationCount(batchId)).toBe(0);
  });

  it('refuses to allocate an orphaned entry', async () => {
    const batchId = await seedDraftBatch();
    const entry = await seedEntry();
    await markSeededEntryCanonical(queries, entry);
    await orphan(entry);

    await expect(
      queries.addSweepBatchEntry({
        sweepBatchId: batchId,
        ledgerEntryId: entry.id,
        allocatedBy: 'treasury-maker',
      }),
    ).rejects.toThrow(`not proven canonical: ${entry.id} (ORPHANED)`);
    expect(await allocationCount(batchId)).toBe(0);
  });

  it('stops a batch at approval when an allocated entry is orphaned, and lets it be voided', async () => {
    const batchId = await seedDraftBatch();
    const entry = await seedEntry();
    await markSeededEntryCanonical(queries, entry);
    await queries.addSweepBatchEntry({
      sweepBatchId: batchId,
      ledgerEntryId: entry.id,
      allocatedBy: 'treasury-maker',
    });

    await orphan(entry);

    await expect(
      queries.updateSweepBatchStatus({
        batchId,
        status: 'PENDING_APPROVAL',
        actor: 'treasury-maker',
      }),
    ).rejects.toThrow(`not proven canonical: ${entry.id} (ORPHANED)`);

    const actors = await sidecar.query(
      `SELECT 1 FROM treasury_transition_actors
       WHERE subject_type = 'SWEEP_BATCH' AND subject_id = $1`,
      [batchId],
    );
    expect(actors.rowCount).toBe(0);

    const voided = await queries.updateSweepBatchStatus({
      batchId,
      status: 'VOID',
      actor: 'treasury-maker',
    });
    expect(voided.status).toBe('VOID');
  });

  it('an orphaning that commits while approval waits on the entry wins', async () => {
    const batchId = await seedDraftBatch();
    const entry = await seedEntry();
    await markSeededEntryCanonical(queries, entry);
    await queries.addSweepBatchEntry({
      sweepBatchId: batchId,
      ledgerEntryId: entry.id,
      allocatedBy: 'treasury-maker',
    });
    await queries.updateSweepBatchStatus({
      batchId,
      status: 'PENDING_APPROVAL',
      actor: 'treasury-maker',
    });

    // The orphaning takes the ledger row first, as recordLedgerEntryOrphaned
    // does, and holds it while the approval arrives.
    const orphaning = await sidecar.connect();
    try {
      await orphaning.query('BEGIN');
      await orphaning.query('SELECT id FROM treasury_ledger_entries WHERE id = $1 FOR UPDATE', [
        entry.id,
      ]);
      await orphaning.query(
        `UPDATE treasury_ledger_entries SET canonicality_state = 'ORPHANED' WHERE id = $1`,
        [entry.id],
      );

      const approval = queries.updateSweepBatchStatus({
        batchId,
        status: 'APPROVED',
        actor: 'treasury-checker',
      });
      const settled = approval.then(
        () => 'committed',
        (error: Error) => error.message,
      );

      // The approval must be blocked on the share lock, not already decided.
      const early = await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
      ]);
      expect(early).toBe('waiting');

      await orphaning.query('COMMIT');
      expect(await settled).toContain(`not proven canonical: ${entry.id} (ORPHANED)`);
    } finally {
      orphaning.release();
    }

    const batch = await sidecar.query<{ status: string }>(
      'SELECT status FROM sweep_batches WHERE id = $1',
      [batchId],
    );
    expect(batch.rows[0].status).toBe('PENDING_APPROVAL');
  });

  describe('matched execution', () => {
    async function seedApprovedBatch(): Promise<number> {
      const batchId = await seedDraftBatch();
      const entry = await seedEntry();
      await markSeededEntryCanonical(queries, entry);
      await queries.addSweepBatchEntry({
        sweepBatchId: batchId,
        ledgerEntryId: entry.id,
        allocatedBy: 'treasury-maker',
      });
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
      return batchId;
    }

    function claimFor(batchId: number) {
      sequence += 1;
      return {
        sourceEventId: `claim-sc-${sequence}`,
        matchedSweepBatchId: batchId,
        txHash: `0xclaimsc${sequence}`,
        blockNumber: 900 + sequence,
        observedAt: new Date('2026-04-16T09:00:00.000Z'),
        treasuryIdentity: `0x${'aa'.repeat(20)}`,
        payoutReceiver: '0xpayoutreceiver',
        amountRaw: '125000000',
        triggeredBy: `0x${'cc'.repeat(20)}`,
      };
    }

    async function claimCount(batchId: number): Promise<number> {
      const result = await sidecar.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM treasury_claim_events WHERE matched_sweep_batch_id = $1',
        [batchId],
      );
      return result.rows[0].count;
    }

    it('names the escrow that emitted the allocated entries', async () => {
      const batchId = await seedApprovedBatch();

      await expect(queries.listSweepBatchEntryLogAddresses(batchId)).resolves.toEqual([
        `0x${'11'.repeat(20)}`,
      ]);
    });

    it('binds the claim and executes the batch in one commit', async () => {
      const batchId = await seedApprovedBatch();
      const claim = claimFor(batchId);

      const batch = await queries.recordSweepBatchExecution({
        claim,
        actor: 'treasury-executor',
      });

      expect(batch.status).toBe('EXECUTED');
      expect(batch.matched_sweep_tx_hash).toBe(claim.txHash);
      expect(await claimCount(batchId)).toBe(1);
    });

    it('leaves no bound claim behind when the transition is refused', async () => {
      // Still DRAFT, so EXECUTED is not a legal transition and the whole write
      // must roll back -- a claim left bound here is what stranded batches.
      const batchId = await seedDraftBatch();

      await expect(
        queries.recordSweepBatchExecution({
          claim: claimFor(batchId),
          actor: 'treasury-executor',
        }),
      ).rejects.toThrow();

      expect(await claimCount(batchId)).toBe(0);
      const batch = await sidecar.query<{ status: string }>(
        'SELECT status FROM sweep_batches WHERE id = $1',
        [batchId],
      );
      expect(batch.rows[0].status).toBe('DRAFT');
    });
  });
});
