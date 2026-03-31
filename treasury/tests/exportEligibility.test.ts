process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL = process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

const { TreasuryEligibilityService } = require('../src/core/exportEligibility') as typeof import('../src/core/exportEligibility');
import { LedgerEntryWithState } from '../src/types';

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
    latest_state: overrides?.latest_state ?? 'READY_FOR_PAYOUT',
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
            ['trade-1', { tradeId: 'trade-1', status: 'CLEAR', runKey: 'run-1', driftCount: 0, blockedReasons: [] }],
          ]),
      },
    });

    const gates = await service.assessEntries([makeEntry({ block_number: 109 })]);
    const gate = gates.get(1);

    expect(gate).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'CLEAR',
        eligibleForPayout: true,
        eligibleForExport: true,
        blockedReasons: [],
      }),
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
            ['trade-1', { tradeId: 'trade-1', status: 'CLEAR', runKey: 'run-1', driftCount: 0, blockedReasons: [] }],
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
    expect(gate?.blockedReasons).toContain('Entry has not reached Base finalized stage (current stage: SAFE)');
  });

  test('blocks payout when reconciliation drift exists even after finalization', async () => {
    const service = new TreasuryEligibilityService({
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            ['trade-1', { tradeId: 'trade-1', status: 'BLOCKED', runKey: 'run-2', driftCount: 2, blockedReasons: ['Latest reconciliation run reported 2 drift finding(s)'] }],
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
});
