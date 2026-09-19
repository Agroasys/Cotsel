/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / FAIL-06 acceptance drill, against a real PostgreSQL instance.
 *
 * The claim under test is that an ingested fee event which the chain later
 * orphans is revoked and cannot become eligible again on height alone. That
 * claim spans the ledger row, an append-only evidence row, the payout lifecycle
 * and the ingestion watermark, in one transaction; a mocked pool proves none of
 * it, so this suite drives the real schema.
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

const INGESTED_BLOCK = 900;
const INGESTED_BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const REORGED_BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const STABLE_BLOCK = 950;

describePostgres('treasury chain reorganization drill (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_chain_reorg');
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

  async function seedIngestedEntry(): Promise<{ entryId: number; entryKey: string }> {
    sequence += 1;
    const entryKey = `reorg-drill-${sequence}`;

    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey,
      tradeId: `trade-reorg-${sequence}`,
      txHash: `0xreorg${sequence}`,
      blockNumber: INGESTED_BLOCK,
      blockHash: INGESTED_BLOCK_HASH,
      logIndex: 3,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '1000000',
      sourceTimestamp: new Date('2026-03-31T00:00:00.000Z'),
      metadata: { source: 'reorg-drill' },
    });

    return { entryId: entry.id, entryKey };
  }

  async function readEntry(entryId: number) {
    const result = await sidecar.query('SELECT * FROM treasury_ledger_entries WHERE id = $1', [
      entryId,
    ]);
    return result.rows[0];
  }

  test('ingestion stores the chain identity and leaves the verdict unproven', async () => {
    const { entryId } = await seedIngestedEntry();
    const entry = await readEntry(entryId);

    expect(entry.block_hash).toBe(INGESTED_BLOCK_HASH);
    expect(entry.log_index).toBe(3);
    // Ingestion records identity; only a re-verification against the chain may
    // assert CANONICAL, so a freshly ingested entry is not yet payable.
    expect(entry.canonicality_state).toBe('UNVERIFIED');
    expect(entry.canonicality_verified_at).toBeNull();
  });

  test('a canonical verdict is recorded against the stable block it was measured at', async () => {
    const { entryId } = await seedIngestedEntry();

    await queries.markLedgerEntryCanonical({
      ledgerEntryId: entryId,
      blockHash: INGESTED_BLOCK_HASH,
      logIndex: 3,
      stableBlockNumber: STABLE_BLOCK,
    });

    const entry = await readEntry(entryId);
    expect(entry.canonicality_state).toBe('CANONICAL');
    expect(entry.canonicality_stable_block_number).toBe(STABLE_BLOCK);
    expect(entry.canonicality_verified_at).not.toBeNull();
  });

  test('orphaning revokes the entry, preserves evidence and rewinds the watermark', async () => {
    const { entryId, entryKey } = await seedIngestedEntry();
    await queries.markLedgerEntryCanonical({
      ledgerEntryId: entryId,
      blockHash: INGESTED_BLOCK_HASH,
      logIndex: 3,
      stableBlockNumber: STABLE_BLOCK,
    });
    await queries.setIngestionWatermark(STABLE_BLOCK + 1, 'trade_events', STABLE_BLOCK);

    const revocation = await queries.recordLedgerEntryOrphaned({
      ledgerEntryId: entryId,
      entryKey,
      tradeId: `trade-reorg-${sequence}`,
      txHash: `0xreorg${sequence}`,
      blockNumber: INGESTED_BLOCK,
      expectedBlockHash: INGESTED_BLOCK_HASH,
      observedBlockHash: REORGED_BLOCK_HASH,
      observedBlockNumber: INGESTED_BLOCK,
      observedLogIndex: null,
      reorgDepth: STABLE_BLOCK - INGESTED_BLOCK,
      stableBlockNumber: STABLE_BLOCK,
      mismatchReason: 'BLOCK_HASH_MISMATCH',
      detail: 'Block 900 is now 0xcd… on the canonical chain',
      cancelFromState: 'PENDING_REVIEW',
      actor: 'system:chain-canonicality',
    });

    expect(revocation.payoutCancelled).toBe(true);

    const entry = await readEntry(entryId);
    expect(entry.canonicality_state).toBe('ORPHANED');
    expect(entry.canonicality_depth).toBe(50);
    expect(entry.canonicality_observed_block_hash).toBe(REORGED_BLOCK_HASH);

    const evidence = await queries.listChainReorgEvents({ ledgerEntryId: entryId, limit: 10 });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(
      expect.objectContaining({
        mismatch_reason: 'BLOCK_HASH_MISMATCH',
        expected_block_hash: INGESTED_BLOCK_HASH,
        observed_block_hash: REORGED_BLOCK_HASH,
        reorg_depth: 50,
        stable_block_number: STABLE_BLOCK,
      }),
    );

    const lifecycle = await queries.getLatestPayoutState(entryId);
    expect(lifecycle?.state).toBe('CANCELLED');

    // Replay at the affected height rather than continuing past it.
    const watermark = await queries.getIngestionWatermark('trade_events');
    expect(watermark).toBe(INGESTED_BLOCK);
  });

  test('re-ingesting the same entry key cannot clear an orphan revocation', async () => {
    const { entryId, entryKey } = await seedIngestedEntry();
    await queries.recordLedgerEntryOrphaned({
      ledgerEntryId: entryId,
      entryKey,
      tradeId: `trade-reorg-${sequence}`,
      txHash: `0xreorg${sequence}`,
      blockNumber: INGESTED_BLOCK,
      expectedBlockHash: INGESTED_BLOCK_HASH,
      observedBlockHash: null,
      observedBlockNumber: null,
      observedLogIndex: null,
      reorgDepth: 50,
      stableBlockNumber: STABLE_BLOCK,
      mismatchReason: 'RECEIPT_MISSING',
      detail: 'Transaction has no receipt on the canonical chain',
      cancelFromState: 'PENDING_REVIEW',
      actor: 'system:chain-canonicality',
    });

    await queries.upsertLedgerEntryWithInitialState({
      entryKey,
      tradeId: `trade-reorg-${sequence}`,
      txHash: `0xreorg${sequence}`,
      blockNumber: INGESTED_BLOCK,
      blockHash: INGESTED_BLOCK_HASH,
      logIndex: 3,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '1000000',
      sourceTimestamp: new Date('2026-03-31T00:00:00.000Z'),
      metadata: { source: 'reorg-drill-replay' },
    });

    expect((await readEntry(entryId)).canonicality_state).toBe('ORPHANED');

    // Nor can a later canonical verdict, which is the "height alone" path the
    // control exists to close.
    await queries.markLedgerEntryCanonical({
      ledgerEntryId: entryId,
      blockHash: INGESTED_BLOCK_HASH,
      logIndex: 3,
      stableBlockNumber: STABLE_BLOCK + 500,
    });

    expect((await readEntry(entryId)).canonicality_state).toBe('ORPHANED');
  });

  test('reorganization evidence is append-only', async () => {
    const { entryId, entryKey } = await seedIngestedEntry();
    await queries.recordLedgerEntryOrphaned({
      ledgerEntryId: entryId,
      entryKey,
      tradeId: `trade-reorg-${sequence}`,
      txHash: `0xreorg${sequence}`,
      blockNumber: INGESTED_BLOCK,
      expectedBlockHash: INGESTED_BLOCK_HASH,
      observedBlockHash: REORGED_BLOCK_HASH,
      observedBlockNumber: INGESTED_BLOCK,
      observedLogIndex: null,
      reorgDepth: 50,
      stableBlockNumber: STABLE_BLOCK,
      mismatchReason: 'BLOCK_HASH_MISMATCH',
      detail: 'conflicting evidence must survive review',
      cancelFromState: null,
      actor: 'system:chain-canonicality',
    });

    await expect(
      sidecar.query(
        'UPDATE treasury_chain_reorg_events SET detail = $1 WHERE ledger_entry_id = $2',
        ['rewritten', entryId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sidecar.query('DELETE FROM treasury_chain_reorg_events WHERE ledger_entry_id = $1', [
        entryId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  test('an entry cannot be marked canonical without a chain identity', async () => {
    sequence += 1;
    await expect(
      sidecar.query(
        `INSERT INTO treasury_ledger_entries (
           entry_key, trade_id, tx_hash, block_number, event_name, component_type,
           amount_raw, source_timestamp, canonicality_state
         ) VALUES ($1, 'trade-x', '0xnohash', 900, 'PlatformFeesPaidStage1', 'PLATFORM_FEE',
                   '1', NOW(), 'CANONICAL')`,
        [`no-identity-${sequence}`],
      ),
    ).rejects.toThrow(/canonical_requires_identity/);
  });
});
