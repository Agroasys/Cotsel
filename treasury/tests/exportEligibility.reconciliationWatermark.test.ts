process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { LedgerEntryWithState } from '../src/types';
import { TreasuryEligibilityService } from '../src/core/exportEligibility';
import type { TradeReconciliationGate } from '../src/core/reconciliationGate';
import {
  alwaysCanonicalVerifier,
  recordingCanonicalityWriter,
  TEST_BLOCK_HASH,
  TEST_LOG_ADDRESS,
  TEST_LOG_IDENTITY_HASH,
} from './helpers/chainCanonicality';
import { freshIngestion } from './helpers/ingestionFreshness';

function gateWith(overrides: Partial<TradeReconciliationGate>): {
  assessTrades: () => Promise<Map<string, TradeReconciliationGate>>;
} {
  const gate: TradeReconciliationGate = {
    tradeId: 'trade-1',
    status: 'CLEAR',
    runKey: 'run-1',
    driftCount: 0,
    freshness: 'FRESH',
    completedAt: new Date('2026-03-31T00:05:00.000Z'),
    staleRunningRunCount: 0,
    coverageFromBlock: 0,
    coverageToBlock: 1_000_000,
    coverageComplete: true,
    blockedReasons: [],
    ...overrides,
  };

  return { assessTrades: async () => new Map([['trade-1', gate]]) };
}

function makeEntry(): LedgerEntryWithState {
  return {
    id: 1,
    entry_key: 'entry-1',
    trade_id: 'trade-1',
    tx_hash: '0xtx-1',
    block_number: 100,
    event_name: 'PlatformFeesPaidStage1',
    component_type: 'PLATFORM_FEE',
    amount_raw: '42',
    source_timestamp: new Date('2026-03-31T00:00:00.000Z'),
    metadata: {},
    created_at: new Date('2026-03-31T00:00:00.000Z'),
    block_hash: TEST_BLOCK_HASH,
    log_index: 0,
    log_address: TEST_LOG_ADDRESS,
    log_identity_hash: TEST_LOG_IDENTITY_HASH,
    canonicality_state: 'UNVERIFIED',
    canonicality_verified_at: null,
    canonicality_observed_block_hash: null,
    canonicality_depth: null,
    canonicality_stable_block_number: null,
    latest_state: 'READY_FOR_EXTERNAL_HANDOFF',
    latest_state_at: new Date('2026-03-31T00:00:00.000Z'),
  };
}

/**
 * WP-4 H-25. Every entry here is finalized, canonical, ingested from a current
 * feed, and covered by a run that is fresh and drift-free. The only variable is
 * how far that run actually reached -- which is the distinction the gate did not
 * previously draw: "the run was clean" and "the run reached this entry" are
 * different claims, and only the second one clears the entry.
 */
function serviceWith(reconciliationGate: ReturnType<typeof gateWith>): TreasuryEligibilityService {
  return new TreasuryEligibilityService({
    ingestionFreshness: freshIngestion(),
    canonicalityVerifier: alwaysCanonicalVerifier(),
    canonicalityWriter: recordingCanonicalityWriter().writer,
    provider: {
      getBlock: async (tag) => {
        if (tag === 'latest') return { number: 120n };
        if (tag === 'safe') return { number: 115n };
        return { number: 110n };
      },
    },
    reconciliationGate,
  });
}

describe('TreasuryEligibilityService reconciliation watermark', () => {
  test('snapshot batches share one finalized anchor and refuse a changed reconciliation run', async () => {
    const getBlock = jest.fn(async (tag: 'latest' | 'safe' | 'finalized') => ({
      number: tag === 'latest' ? 120n : tag === 'safe' ? 115n : 110n,
      hash: `0x${'ab'.repeat(32)}`,
    }));
    const assessTrades = jest
      .fn()
      .mockImplementationOnce(gateWith({ runKey: 'run-1' }).assessTrades)
      .mockImplementationOnce(gateWith({ runKey: 'run-2' }).assessTrades);
    const service = new TreasuryEligibilityService({
      provider: { getBlock },
      ingestionFreshness: freshIngestion(),
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      reconciliationGate: { assessTrades },
    });
    const context = await service.createSnapshotContext();
    expect(context.finalizedBlockHash).toBe(`0x${'ab'.repeat(32)}`);
    expect((await service.assessEntries([makeEntry()], context)).get(1)?.eligibleForExport).toBe(
      true,
    );
    expect(getBlock).toHaveBeenCalledTimes(3);
    await expect(service.verifySnapshotContext(context)).rejects.toThrow(
      'Reconciliation evidence changed or became unavailable',
    );
    expect(getBlock).toHaveBeenCalledTimes(5);
  });

  test('snapshot verification refuses a changed finalized block hash', async () => {
    let changed = false;
    const service = new TreasuryEligibilityService({
      provider: {
        getBlock: async (tag) => ({
          number: tag === 'latest' ? 120n : tag === 'safe' ? 115n : 110n,
          hash: `0x${(changed && typeof tag === 'number' ? 'cd' : 'ab').repeat(32)}`,
        }),
      },
      ingestionFreshness: freshIngestion(),
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      reconciliationGate: gateWith({}),
    });
    const context = await service.createSnapshotContext();
    await service.assessEntries([makeEntry()], context);
    changed = true;
    await expect(service.verifySnapshotContext(context)).rejects.toThrow(
      'Finalized chain anchor changed or is unavailable',
    );
  });

  test('snapshot context refuses a finalized head without a hash', async () => {
    await expect(serviceWith(gateWith({})).createSnapshotContext()).rejects.toThrow(
      'Finalized chain anchor is unavailable',
    );
  });

  test('clears an entry the accepted run reached', async () => {
    const gate = (await serviceWith(gateWith({})).assessEntries([makeEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(true);
    expect(gate?.reconciliationCoverageToBlock).toBe(1_000_000);
    expect(gate?.reconciliationCoverageComplete).toBe(true);
  });

  test('blocks an entry above the run coverage watermark', async () => {
    // The entry sits at block 100; the run stopped at 99.
    const gate = (
      await serviceWith(gateWith({ coverageToBlock: 99 })).assessEntries([makeEntry()])
    ).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.blockedReasons).toContain(
      'Entry block 100 is beyond reconciliation run run-1 coverage watermark 99.',
    );
  });

  test('clears an entry sitting exactly on the watermark', async () => {
    const gate = (
      await serviceWith(gateWith({ coverageToBlock: 100 })).assessEntries([makeEntry()])
    ).get(1);

    expect(gate?.eligibleForPayout).toBe(true);
  });

  test('blocks when the run published no watermark at all', async () => {
    const gate = (
      await serviceWith(gateWith({ coverageToBlock: null, coverageComplete: null })).assessEntries([
        makeEntry(),
      ])
    ).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.blockedReasons).toContain(
      'Reconciliation run has no chain coverage watermark, so it cannot be bound to this entry.',
    );
  });

  /**
   * A truncated sweep clears every trade it happened to reach and says nothing
   * about the ones it did not, which downstream is indistinguishable from a
   * clean run unless the incompleteness itself blocks.
   */
  test('blocks on a run that reported an incomplete range', async () => {
    const gate = (
      await serviceWith(
        gateWith({
          status: 'BLOCKED',
          coverageComplete: false,
          blockedReasons: [
            'Latest completed reconciliation run published an incomplete chain range',
          ],
        }),
      ).assessEntries([makeEntry()])
    ).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.blockedReasons).toContain(
      'Latest completed reconciliation run published an incomplete chain range',
    );
  });
});
