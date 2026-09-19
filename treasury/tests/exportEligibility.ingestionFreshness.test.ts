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
import type { IngestionFreshnessAssessment } from '../src/core/ingestionFreshness';
import {
  alwaysCanonicalVerifier,
  recordingCanonicalityWriter,
  TEST_BLOCK_HASH,
  TEST_LOG_ADDRESS,
  TEST_LOG_IDENTITY_HASH,
} from './helpers/chainCanonicality';
import {
  freshIngestion,
  freshIngestionAssessment,
  staleIngestion,
} from './helpers/ingestionFreshness';

const clearReconciliation = {
  assessTrades: async () =>
    new Map([
      [
        'trade-1',
        {
          tradeId: 'trade-1',
          status: 'CLEAR' as const,
          runKey: 'run-1',
          driftCount: 0,
          freshness: 'FRESH' as const,
          completedAt: new Date('2026-03-31T00:05:00.000Z'),
          staleRunningRunCount: 0,
          coverageFromBlock: 0,
          coverageToBlock: 1_000_000,
          coverageComplete: true,
          blockedReasons: [],
        },
      ],
    ]),
};

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
 * Every entry here is finalized, canonical and reconciled. The only variable is
 * whether the feed that produced it is still running, which is the point: stale
 * ingestion does not make a stored entry wrong, it makes the absence of a later
 * entry meaningless, and nothing else in the assessment can notice that.
 */
function serviceWith(ingestionFreshness: {
  assess: (options?: {
    stableBlockNumber?: number | null;
  }) => Promise<IngestionFreshnessAssessment>;
}): TreasuryEligibilityService {
  return new TreasuryEligibilityService({
    ingestionFreshness,
    canonicalityVerifier: alwaysCanonicalVerifier(),
    canonicalityWriter: recordingCanonicalityWriter().writer,
    provider: {
      getBlock: async (tag) => {
        if (tag === 'latest') return { number: 120n };
        if (tag === 'safe') return { number: 115n };
        return { number: 110n };
      },
    },
    reconciliationGate: clearReconciliation,
  });
}

describe('TreasuryEligibilityService ingestion freshness', () => {
  test('blocks an otherwise clear entry while chain-evidence ingestion is stale', async () => {
    const gate = (await serviceWith(staleIngestion()).assessEntries([makeEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.eligibleForExport).toBe(false);
    expect(gate?.blockedReasons).toContain(
      'Treasury ingestion last completed 3600s ago, beyond the 900s freshness threshold.',
    );
  });

  test('blocks when ingestion has never completed a run', async () => {
    const reason =
      'Treasury ingestion has never completed a run for claim_events, trade_events; chain evidence coverage is unproven.';
    const gate = (await serviceWith(staleIngestion([reason])).assessEntries([makeEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.blockedReasons).toContain(reason);
  });

  /**
   * The finalized head is read once per assessment for the confirmation stage,
   * and the lag check reuses it. Reading it a second time would judge the two
   * halves of one verdict against different views of the chain.
   */
  test('passes the finalized head it already read into the freshness assessment', async () => {
    const assess = jest.fn(async () => freshIngestionAssessment());

    await serviceWith({ assess }).assessEntries([makeEntry()]);

    expect(assess).toHaveBeenCalledWith({ stableBlockNumber: 110 });
  });

  test('clears the entry once ingestion is fresh again', async () => {
    const gate = (await serviceWith(freshIngestion()).assessEntries([makeEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(true);
    expect(gate?.eligibleForExport).toBe(true);
  });
});
