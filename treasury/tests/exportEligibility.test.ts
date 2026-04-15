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

function makeEntry(overrides?: Partial<LedgerEntryWithState>): LedgerEntryWithState {
  return {
    id: overrides?.id ?? 1,
    entry_key: overrides?.entry_key ?? 'entry-1',
    trade_id: overrides?.trade_id ?? 'trade-1',
    tx_hash: overrides?.tx_hash ?? '0xtx-1',
    block_number: overrides?.block_number ?? 100,
    event_name: overrides?.event_name ?? 'PlatformFeesPaidStage1',
    component_type: overrides?.component_type ?? 'PLATFORM_FEE',
    amount_raw: overrides?.amount_raw ?? '42',
    source_timestamp: overrides?.source_timestamp ?? new Date('2026-03-31T00:00:00.000Z'),
    metadata: overrides?.metadata ?? {},
    created_at: overrides?.created_at ?? new Date('2026-03-31T00:00:00.000Z'),
    latest_state: overrides?.latest_state ?? 'READY_FOR_EXTERNAL_HANDOFF',
    latest_state_at: overrides?.latest_state_at ?? new Date('2026-03-31T00:00:00.000Z'),
  };
}

describe('TreasuryEligibilityService', () => {
  test('allows payout/export only when finalized and reconciliation is clear', async () => {
    const service = new TreasuryEligibilityService({
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
    const service = new TreasuryEligibilityService({
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
    const service = new TreasuryEligibilityService({
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
    const service = new TreasuryEligibilityService({
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
    const service = new TreasuryEligibilityService({
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
