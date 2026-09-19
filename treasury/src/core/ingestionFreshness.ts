/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-10: the one place that answers "is treasury's chain
 * evidence current enough to act on".
 *
 * Treasury published two health signals and neither knew anything about
 * ingestion. A stopped ingester therefore stayed green indefinitely while
 * export, realization and close kept clearing entries against fee evidence that
 * had stopped advancing. The gap was not that the data was wrong; it was that
 * nothing could tell the difference between "caught up" and "not running".
 *
 * Freshness is deliberately assessed from the cursor rather than from a live
 * chain read. Readiness is probed continuously and must not depend on the
 * settlement RPC being reachable -- an RPC outage is what *causes* staleness,
 * so making the detector depend on it would silence the alarm exactly when it
 * matters. Callers that already hold a finalized head pass it in and get the
 * block-lag check as well.
 */
import { config } from '../config';
import {
  listIngestionCursorStates,
  type IngestionCursorState,
} from '../database/queries/ingestion';
import { INGESTION_CURSORS } from './ingestion';

/**
 * `NEVER_RUN` is separated from `STALE` because they call for different
 * operator action: one is a deployment that has not started ingesting, the
 * other is an ingester that stopped. Both block.
 */
export type IngestionFreshnessStatus = 'FRESH' | 'STALE' | 'NEVER_RUN' | 'UNKNOWN';

export interface IngestionFreshnessAssessment {
  status: IngestionFreshnessStatus;
  lastSuccessAt: Date | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  lagBlocks: number | null;
  maxLagBlocks: number;
  ingestedThroughBlockNumber: number | null;
  stableBlockNumber: number | null;
  consecutiveFailureCount: number;
  lastBlockedReason: string | null;
  blockedReasons: string[];
}

interface CursorStateReader {
  listStates(cursorNames: string[]): Promise<IngestionCursorState[]>;
}

export class TreasuryIngestionFreshnessService {
  private readonly reader: CursorStateReader;
  private readonly now: () => Date;
  private readonly maxAgeSeconds: number;
  private readonly maxLagBlocks: number;

  constructor(deps?: {
    reader?: CursorStateReader;
    now?: () => Date;
    maxAgeSeconds?: number;
    maxLagBlocks?: number;
  }) {
    this.reader = deps?.reader ?? { listStates: listIngestionCursorStates };
    this.now = deps?.now ?? (() => new Date());
    this.maxAgeSeconds = deps?.maxAgeSeconds ?? config.ingestionMaxAgeSeconds;
    this.maxLagBlocks = deps?.maxLagBlocks ?? config.ingestionMaxLagBlocks;
  }

  async assess(options?: {
    stableBlockNumber?: number | null;
  }): Promise<IngestionFreshnessAssessment> {
    const stableBlockNumber = options?.stableBlockNumber ?? null;
    let states: IngestionCursorState[];

    try {
      states = await this.reader.listStates(INGESTION_CURSORS);
    } catch {
      // The store that holds the answer is unreachable, so the honest verdict
      // is that freshness is unknown -- and unknown blocks, like every other
      // undetermined control on this path.
      return this.unknown(stableBlockNumber);
    }

    const missingCursors = INGESTION_CURSORS.filter(
      (cursorName) => !states.some((state) => state.cursorName === cursorName),
    );
    const neverSucceeded = states.filter((state) => state.lastSuccessAt === null);

    // Both cursors advance in the same run, so the weakest one governs: a fresh
    // trade cursor beside a stalled claim cursor is a stalled ingester.
    const lastSuccessAt = states.reduce<Date | null>((oldest, state) => {
      if (!state.lastSuccessAt) {
        return oldest;
      }
      return oldest === null || state.lastSuccessAt < oldest ? state.lastSuccessAt : oldest;
    }, null);
    const consecutiveFailureCount = states.reduce(
      (highest, state) => Math.max(highest, state.consecutiveFailureCount),
      0,
    );
    const lastBlockedReason =
      states.find((state) => state.lastBlockedReason !== null)?.lastBlockedReason ?? null;
    const ingestedThroughBlockNumber = states.reduce<number | null>((lowest, state) => {
      if (state.lastIngestedThroughBlockNumber === null) {
        return lowest;
      }
      return lowest === null || state.lastIngestedThroughBlockNumber < lowest
        ? state.lastIngestedThroughBlockNumber
        : lowest;
    }, null);

    if (missingCursors.length > 0 || neverSucceeded.length > 0 || lastSuccessAt === null) {
      const namedCursors = [
        ...missingCursors,
        ...neverSucceeded.map((state) => state.cursorName),
      ].sort();

      return {
        status: 'NEVER_RUN',
        lastSuccessAt: null,
        ageSeconds: null,
        maxAgeSeconds: this.maxAgeSeconds,
        lagBlocks: null,
        maxLagBlocks: this.maxLagBlocks,
        ingestedThroughBlockNumber,
        stableBlockNumber,
        consecutiveFailureCount,
        lastBlockedReason,
        blockedReasons: [
          `Treasury ingestion has never completed a run for ${namedCursors.join(', ')}; chain evidence coverage is unproven.`,
          ...(lastBlockedReason
            ? [`Last ingestion attempt was refused: ${lastBlockedReason}`]
            : []),
        ],
      };
    }

    const ageSeconds = Math.max(
      0,
      Math.floor((this.now().getTime() - lastSuccessAt.getTime()) / 1000),
    );
    const lagBlocks =
      stableBlockNumber !== null && ingestedThroughBlockNumber !== null
        ? Math.max(0, stableBlockNumber - ingestedThroughBlockNumber)
        : null;

    const blockedReasons: string[] = [];
    if (ageSeconds > this.maxAgeSeconds) {
      blockedReasons.push(
        `Treasury ingestion last completed ${ageSeconds}s ago, beyond the ${this.maxAgeSeconds}s freshness threshold.`,
      );
    }

    if (lagBlocks !== null && lagBlocks > this.maxLagBlocks) {
      blockedReasons.push(
        `Treasury ingestion is ${lagBlocks} block(s) behind the finalized head, beyond the ${this.maxLagBlocks}-block lag threshold.`,
      );
    }

    if (blockedReasons.length > 0 && lastBlockedReason) {
      blockedReasons.push(`Last ingestion attempt was refused: ${lastBlockedReason}`);
    }

    return {
      status: blockedReasons.length > 0 ? 'STALE' : 'FRESH',
      lastSuccessAt,
      ageSeconds,
      maxAgeSeconds: this.maxAgeSeconds,
      lagBlocks,
      maxLagBlocks: this.maxLagBlocks,
      ingestedThroughBlockNumber,
      stableBlockNumber,
      consecutiveFailureCount,
      lastBlockedReason,
      blockedReasons,
    };
  }

  private unknown(stableBlockNumber: number | null): IngestionFreshnessAssessment {
    return {
      status: 'UNKNOWN',
      lastSuccessAt: null,
      ageSeconds: null,
      maxAgeSeconds: this.maxAgeSeconds,
      lagBlocks: null,
      maxLagBlocks: this.maxLagBlocks,
      ingestedThroughBlockNumber: null,
      stableBlockNumber,
      consecutiveFailureCount: 0,
      lastBlockedReason: null,
      blockedReasons: [
        'Treasury ingestion freshness could not be determined because the ingestion state could not be read.',
      ],
    };
  }
}
