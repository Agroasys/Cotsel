process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { TreasuryIngestionFreshnessService } from '../src/core/ingestionFreshness';
import type { IngestionCursorState } from '../src/database/queries/ingestion';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function cursor(overrides: Partial<IngestionCursorState> & { cursorName: string }) {
  return {
    nextBlockNumber: 900,
    lastIngestedThroughBlockNumber: 880,
    lastAttemptAt: NOW,
    lastSuccessAt: NOW,
    lastBlockedReason: null,
    lastPartialReason: null,
    consecutiveFailureCount: 0,
    ...overrides,
  } satisfies IngestionCursorState;
}

function secondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function makeService(states: IngestionCursorState[] | Error) {
  return new TreasuryIngestionFreshnessService({
    reader: {
      listStates: async () => {
        if (states instanceof Error) {
          throw states;
        }
        return states;
      },
    },
    now: () => NOW,
    maxAgeSeconds: 900,
    maxLagBlocks: 300,
  });
}

/**
 * WP-4 B-09 / FAIL-10.
 *
 * The property under test is narrow and is the whole finding: a treasury whose
 * ingestion has stopped must not report itself usable. Every branch here
 * therefore asserts a refusal, and the one FRESH case exists to prove the gate
 * can actually open.
 */
describe('TreasuryIngestionFreshnessService', () => {
  it('reports FRESH when both cursors completed inside the threshold and near the head', async () => {
    const service = makeService([
      cursor({ cursorName: 'trade_events', lastSuccessAt: secondsAgo(60) }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: secondsAgo(30) }),
    ]);

    const assessment = await service.assess({ stableBlockNumber: 900 });

    expect(assessment.status).toBe('FRESH');
    expect(assessment.blockedReasons).toEqual([]);
    expect(assessment.ageSeconds).toBe(60);
    expect(assessment.lagBlocks).toBe(20);
  });

  it('blocks when the last completed run is older than the freshness threshold', async () => {
    const service = makeService([
      cursor({ cursorName: 'trade_events', lastSuccessAt: secondsAgo(1800) }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: secondsAgo(1800) }),
    ]);

    const assessment = await service.assess();

    expect(assessment.status).toBe('STALE');
    expect(assessment.ageSeconds).toBe(1800);
    expect(assessment.blockedReasons).toEqual([
      'Treasury ingestion last completed 1800s ago, beyond the 900s freshness threshold.',
    ]);
  });

  /**
   * The stalled cursor is the one that matters even though its sibling is
   * current. Reporting the newest success would let one advancing cursor mask
   * the other's outage.
   */
  it('judges freshness by the furthest-behind cursor, not the most recent one', async () => {
    const service = makeService([
      cursor({ cursorName: 'trade_events', lastSuccessAt: secondsAgo(30) }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: secondsAgo(4000) }),
    ]);

    const assessment = await service.assess();

    expect(assessment.status).toBe('STALE');
    expect(assessment.ageSeconds).toBe(4000);
  });

  it('blocks on block lag even while the run clock is inside the threshold', async () => {
    const service = makeService([
      cursor({
        cursorName: 'trade_events',
        lastSuccessAt: secondsAgo(10),
        lastIngestedThroughBlockNumber: 500,
      }),
      cursor({
        cursorName: 'claim_events',
        lastSuccessAt: secondsAgo(10),
        lastIngestedThroughBlockNumber: 500,
      }),
    ]);

    const assessment = await service.assess({ stableBlockNumber: 1200 });

    expect(assessment.status).toBe('STALE');
    expect(assessment.lagBlocks).toBe(700);
    expect(assessment.blockedReasons).toContain(
      'Treasury ingestion is 700 block(s) behind the finalized head, beyond the 300-block lag threshold.',
    );
  });

  it('carries the refusal reason of the last attempt into the blocked output', async () => {
    const service = makeService([
      cursor({
        cursorName: 'trade_events',
        lastSuccessAt: secondsAgo(3600),
        lastBlockedReason: 'Settlement RPC did not report a finalized head',
        consecutiveFailureCount: 12,
      }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: secondsAgo(3600) }),
    ]);

    const assessment = await service.assess();

    expect(assessment.consecutiveFailureCount).toBe(12);
    expect(assessment.blockedReasons).toContain(
      'Last ingestion attempt was refused: Settlement RPC did not report a finalized head',
    );
  });

  it('separates a deployment that never ingested from one that stopped', async () => {
    const service = makeService([
      cursor({ cursorName: 'trade_events', lastSuccessAt: null }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: null }),
    ]);

    const assessment = await service.assess();

    expect(assessment.status).toBe('NEVER_RUN');
    expect(assessment.blockedReasons[0]).toBe(
      'Treasury ingestion has never completed a run for claim_events, trade_events; chain evidence coverage is unproven.',
    );
  });

  it('treats an absent cursor row as unproven coverage rather than silence', async () => {
    const service = makeService([cursor({ cursorName: 'trade_events' })]);

    const assessment = await service.assess();

    expect(assessment.status).toBe('NEVER_RUN');
    expect(assessment.blockedReasons[0]).toContain('claim_events');
  });

  it('fails closed when the ingestion state cannot be read at all', async () => {
    const service = makeService(new Error('connection terminated'));

    const assessment = await service.assess();

    expect(assessment.status).toBe('UNKNOWN');
    expect(assessment.blockedReasons).toEqual([
      'Treasury ingestion freshness could not be determined because the ingestion state could not be read.',
    ]);
  });

  /**
   * Readiness is probed continuously and must not depend on the settlement RPC:
   * an RPC outage is a cause of staleness, so a freshness check that needed the
   * chain would go quiet exactly when the alarm is due.
   */
  it('assesses freshness without a chain head when none is supplied', async () => {
    const service = makeService([
      cursor({ cursorName: 'trade_events', lastSuccessAt: secondsAgo(60) }),
      cursor({ cursorName: 'claim_events', lastSuccessAt: secondsAgo(60) }),
    ]);

    const assessment = await service.assess();

    expect(assessment.status).toBe('FRESH');
    expect(assessment.lagBlocks).toBeNull();
    expect(assessment.stableBlockNumber).toBeNull();
  });
});
