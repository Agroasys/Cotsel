process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { LedgerEntryWithState } from '../src/types';
import {
  alwaysCanonicalVerifier,
  recordingCanonicalityWriter,
  stubVerifier,
  TEST_BLOCK_HASH,
  TEST_LOG_ADDRESS,
  TEST_LOG_IDENTITY_HASH,
  TEST_REORGED_BLOCK_HASH,
} from './helpers/chainCanonicality';
import { eligibilityServiceWithFreshIngestion } from './helpers/eligibilityService';

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
          blockedReasons: [],
        },
      ],
    ]),
};

// Spread rather than `??` per field: a test that sets `block_hash: null` is
// making a point about an entry with no chain identity, and a nullish default
// would quietly overwrite it.
function makeEntry(overrides?: Partial<LedgerEntryWithState>): LedgerEntryWithState {
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
    ...overrides,
  };
}

describe('TreasuryEligibilityService', () => {
  test('allows payout/export only when finalized and reconciliation is clear', async () => {
    const service = eligibilityServiceWithFreshIngestion({
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      provider: {
        getBlock: async (tag) => {
          if (tag === 'latest') return { number: 120n };
          if (tag === 'safe') return { number: 115n };
          return { number: 110n };
        },
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'CLEAR',
                runKey: 'run-1',
                driftCount: 0,
                freshness: 'FRESH',
                completedAt: new Date('2026-03-31T00:05:00.000Z'),
                staleRunningRunCount: 0,
                blockedReasons: [],
              },
            ],
          ]),
      },
    });

    const gates = await service.assessEntries([makeEntry({ block_number: 109 })]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'CLEAR',
        reconciliationFreshness: 'FRESH',
        reconciliationCompletedAt: new Date('2026-03-31T00:05:00.000Z'),
        staleRunningRunCount: 0,
        eligibleForPayout: true,
        eligibleForExport: true,
        blockedReasons: [],
      }),
    );
  });

  test('blocks completed-state export when confirmed payout evidence is missing', async () => {
    const service = eligibilityServiceWithFreshIngestion({
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'CLEAR',
                runKey: 'run-1',
                driftCount: 0,
                freshness: 'FRESH',
                completedAt: new Date('2026-03-31T00:05:00.000Z'),
                staleRunningRunCount: 0,
                blockedReasons: [],
              },
            ],
          ]),
      },
      bankConfirmationReader: {
        getLatestConfirmation: async () => null,
      },
    });

    const gates = await service.assessEntries([
      makeEntry({ block_number: 100, latest_state: 'EXTERNAL_EXECUTION_CONFIRMED' }),
    ]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(gate?.blockedReasons).toContain(
      'Confirmed external execution evidence is required before completion export.',
    );
  });

  test('blocks export before Base finalized stage even when reconciliation is clear', async () => {
    const service = eligibilityServiceWithFreshIngestion({
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      provider: {
        getBlock: async (tag) => {
          if (tag === 'latest') return { number: 120n };
          if (tag === 'safe') return { number: 115n };
          return { number: 100n };
        },
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'CLEAR',
                runKey: 'run-1',
                driftCount: 0,
                freshness: 'FRESH',
                completedAt: new Date('2026-03-31T00:05:00.000Z'),
                staleRunningRunCount: 0,
                blockedReasons: [],
              },
            ],
          ]),
      },
    });

    const gates = await service.assessEntries([makeEntry({ block_number: 114 })]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'SAFE',
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(gate?.blockedReasons).toContain(
      'Entry has not reached Base finalized stage (current stage: SAFE)',
    );
  });

  test('blocks payout when reconciliation drift exists even after finalization', async () => {
    const service = eligibilityServiceWithFreshIngestion({
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'BLOCKED',
                runKey: 'run-2',
                driftCount: 2,
                freshness: 'FRESH',
                completedAt: new Date('2026-03-31T00:05:00.000Z'),
                staleRunningRunCount: 0,
                blockedReasons: ['Latest reconciliation run reported 2 drift finding(s)'],
              },
            ],
          ]),
      },
    });

    const gates = await service.assessEntries([makeEntry({ block_number: 100 })]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'BLOCKED',
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(gate?.blockedReasons).toContain('Latest reconciliation run reported 2 drift finding(s)');
  });

  test('blocks payout when reconciliation freshness is stale even after finalization', async () => {
    const staleCompletedAt = new Date('2026-03-31T00:00:00.000Z');
    const service = eligibilityServiceWithFreshIngestion({
      canonicalityVerifier: alwaysCanonicalVerifier(),
      canonicalityWriter: recordingCanonicalityWriter().writer,
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'BLOCKED',
                runKey: 'run-3',
                driftCount: 0,
                freshness: 'STALE',
                completedAt: staleCompletedAt,
                staleRunningRunCount: 1,
                blockedReasons: [
                  'Latest completed reconciliation run is older than 900 seconds',
                  '1 reconciliation run(s) have remained RUNNING beyond 900 seconds',
                ],
              },
            ],
          ]),
      },
    });

    const gates = await service.assessEntries([makeEntry({ block_number: 100 })]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'BLOCKED',
        reconciliationFreshness: 'STALE',
        reconciliationCompletedAt: staleCompletedAt,
        staleRunningRunCount: 1,
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(gate?.blockedReasons).toContain(
      'Latest completed reconciliation run is older than 900 seconds',
    );
  });
});

/**
 * WP-4 B-08 and FAIL-06 acceptance.
 *
 * The property under test is the one height alone can never provide: an entry
 * that is deep below the finalized head, whose reconciliation is clear and
 * whose lifecycle is ready, still must not become payable once the chain no
 * longer contains it.
 */
describe('TreasuryEligibilityService chain canonicality', () => {
  const orphanedEntry = () =>
    makeEntry({
      block_number: 100,
      tx_hash: '0xtx-1',
      block_hash: TEST_BLOCK_HASH,
      log_index: 0,
      canonicality_state: 'UNVERIFIED',
    });

  test('clears an entry the chain still contains and records the verdict', async () => {
    const canonicality = recordingCanonicalityWriter();
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: stubVerifier({
        finalizedBlockNumber: 150,
        receipts: [{ txHash: '0xtx-1', blockNumber: 100, blockHash: TEST_BLOCK_HASH, logIndex: 0 }],
      }),
      canonicalityWriter: canonicality.writer,
    });

    const gate = (await service.assessEntries([orphanedEntry()])).get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        canonicalityState: 'CANONICAL',
        canonicalityDepth: null,
        canonicalityStableBlockNumber: 150,
        eligibleForPayout: true,
        eligibleForExport: true,
        blockedReasons: [],
      }),
    );
    expect(canonicality.marked).toEqual([{ ledgerEntryId: 1, blockHash: TEST_BLOCK_HASH }]);
    expect(canonicality.orphaned).toHaveLength(0);
  });

  test('revokes eligibility when the block at the entry height is no longer the ingested block', async () => {
    const canonicality = recordingCanonicalityWriter();
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: stubVerifier({
        finalizedBlockNumber: 150,
        receipts: [
          // Same height, same transaction, different block: the reorganization
          // replaced the block the fee event was read from.
          { txHash: '0xtx-1', blockNumber: 100, blockHash: TEST_REORGED_BLOCK_HASH, logIndex: 0 },
        ],
      }),
      canonicalityWriter: canonicality.writer,
    });

    const gate = (await service.assessEntries([orphanedEntry()])).get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'CLEAR',
        canonicalityState: 'ORPHANED',
        canonicalityDepth: 50,
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(canonicality.orphaned).toHaveLength(1);
    expect(canonicality.orphaned[0]).toEqual(
      expect.objectContaining({
        mismatchReason: 'BLOCK_HASH_MISMATCH',
        expectedBlockHash: TEST_BLOCK_HASH,
        observedBlockHash: TEST_REORGED_BLOCK_HASH,
        reorgDepth: 50,
        stableBlockNumber: 150,
        cancelFromState: 'READY_FOR_EXTERNAL_HANDOFF',
      }),
    );
  });

  test('revokes eligibility when the reorganization dropped the transaction entirely', async () => {
    const canonicality = recordingCanonicalityWriter();
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: stubVerifier({ finalizedBlockNumber: 150, receipts: [] }),
      canonicalityWriter: canonicality.writer,
    });

    const gate = (await service.assessEntries([orphanedEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(canonicality.orphaned[0]).toEqual(
      expect.objectContaining({ mismatchReason: 'RECEIPT_MISSING', reorgDepth: 50 }),
    );
  });

  test('revokes eligibility when the receipt no longer carries the ingested log', async () => {
    const canonicality = recordingCanonicalityWriter();
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: stubVerifier({
        finalizedBlockNumber: 150,
        receipts: [{ txHash: '0xtx-1', blockNumber: 100, blockHash: TEST_BLOCK_HASH, logIndex: 4 }],
      }),
      canonicalityWriter: canonicality.writer,
    });

    const gate = (await service.assessEntries([orphanedEntry()])).get(1);

    expect(gate?.eligibleForPayout).toBe(false);
    expect(canonicality.orphaned[0]).toEqual(
      expect.objectContaining({ mismatchReason: 'LOG_IDENTITY_MISMATCH' }),
    );
  });

  test('an already orphaned entry stays blocked and is never re-asked of the chain', async () => {
    const canonicality = recordingCanonicalityWriter();
    const verifier = stubVerifier({
      finalizedBlockNumber: 150,
      // The chain now agrees again. The revocation must survive it anyway.
      receipts: [{ txHash: '0xtx-1', blockNumber: 100, blockHash: TEST_BLOCK_HASH, logIndex: 0 }],
    });
    const verifySpy = jest.spyOn(verifier, 'verify');
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: verifier,
      canonicalityWriter: canonicality.writer,
    });

    const gate = (
      await service.assessEntries([
        makeEntry({
          block_number: 100,
          canonicality_state: 'ORPHANED',
          canonicality_depth: 50,
          canonicality_stable_block_number: 150,
        }),
      ])
    ).get(1);

    expect(gate?.canonicalityState).toBe('ORPHANED');
    expect(gate?.eligibleForPayout).toBe(false);
    expect(gate?.blockedReasons).toContain(
      'Entry was orphaned by a chain reorganization at depth 50 and cannot become eligible again without an approved correction.',
    );
    expect(verifySpy).not.toHaveBeenCalled();
    expect(canonicality.marked).toHaveLength(0);
  });

  test('blocks an entry ingested without a chain identity instead of assuming it', async () => {
    const canonicality = recordingCanonicalityWriter();
    const service = eligibilityServiceWithFreshIngestion({
      provider: { getBlock: async () => ({ number: 150n }) },
      reconciliationGate: clearReconciliation,
      canonicalityVerifier: stubVerifier({
        finalizedBlockNumber: 150,
        receipts: [{ txHash: '0xtx-1', blockNumber: 100, blockHash: TEST_BLOCK_HASH, logIndex: 0 }],
      }),
      canonicalityWriter: canonicality.writer,
    });

    const gate = (
      await service.assessEntries([
        makeEntry({
          block_number: 100,
          block_hash: null,
          log_index: null,
          log_address: null,
          log_identity_hash: null,
        }),
      ])
    ).get(1);

    expect(gate?.canonicalityState).toBe('UNVERIFIED');
    expect(gate?.eligibleForPayout).toBe(false);
    expect(canonicality.orphaned).toHaveLength(0);
  });
});
