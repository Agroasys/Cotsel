/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ListSettlementHandoffsInput,
  SettlementExecutionEventRecord,
  SettlementExecutionStatus,
  SettlementHandoffRecord,
  SettlementReconciliationStatus,
  SettlementStore,
  TradeSettlementProjection,
} from './settlementStore';

export interface ReconciliationSourceFreshness {
  source: 'gateway_settlement_ledger';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
}

export interface ReconciliationRecord {
  handoffId: string;
  tradeId: string;
  platformId: string;
  platformHandoffId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  assetSymbol: string | null;
  assetAmount: number | null;
  ricardianHash: string | null;
  externalReference: string | null;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  callbackStatus: SettlementHandoffRecord['callbackStatus'];
  providerStatus: string | null;
  txHash: string | null;
  extrinsicHash: string | null;
  latestEventType: SettlementHandoffRecord['latestEventType'];
  latestEventDetail: string | null;
  latestEventAt: string | null;
  callbackDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  tradeProjection: TradeSettlementProjection | null;
}

export interface ReconciliationListResult {
  items: ReconciliationRecord[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  freshness: ReconciliationSourceFreshness;
}

export interface ReconciliationDetailResult {
  handoff: ReconciliationRecord | null;
  events: SettlementExecutionEventRecord[];
  freshness: ReconciliationSourceFreshness;
}

export interface ReconciliationListQuery {
  tradeId?: string;
  reconciliationStatus?: SettlementReconciliationStatus;
  executionStatus?: SettlementExecutionStatus;
  limit: number;
  offset: number;
}

export interface ReconciliationReadReader {
  listReconciliation(query: ReconciliationListQuery): Promise<ReconciliationListResult>;
  getReconciliationHandoff(handoffId: string): Promise<ReconciliationDetailResult>;
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestValue: string | null = null;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      continue;
    }

    if (parsed > latestMs) {
      latestMs = parsed;
      latestValue = new Date(parsed).toISOString();
    }
  }

  return latestValue;
}

function mapReconciliationRecord(
  handoff: SettlementHandoffRecord,
  tradeProjection: TradeSettlementProjection | null,
): ReconciliationRecord {
  return {
    handoffId: handoff.handoffId,
    tradeId: handoff.tradeId,
    platformId: handoff.platformId,
    platformHandoffId: handoff.platformHandoffId,
    phase: handoff.phase,
    settlementChannel: handoff.settlementChannel,
    displayCurrency: handoff.displayCurrency,
    displayAmount: handoff.displayAmount,
    assetSymbol: handoff.assetSymbol,
    assetAmount: handoff.assetAmount,
    ricardianHash: handoff.ricardianHash,
    externalReference: handoff.externalReference,
    executionStatus: handoff.executionStatus,
    reconciliationStatus: handoff.reconciliationStatus,
    callbackStatus: handoff.callbackStatus,
    providerStatus: handoff.providerStatus,
    txHash: handoff.txHash,
    extrinsicHash: handoff.extrinsicHash,
    latestEventType: handoff.latestEventType,
    latestEventDetail: handoff.latestEventDetail,
    latestEventAt: handoff.latestEventAt,
    callbackDeliveredAt: handoff.callbackDeliveredAt,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
    tradeProjection,
  };
}

function degradedReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Settlement ledger is unavailable';
}

export class ReconciliationReadService implements ReconciliationReadReader {
  constructor(
    private readonly settlementStore: SettlementStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listReconciliation(query: ReconciliationListQuery): Promise<ReconciliationListResult> {
    const queriedAt = this.now().toISOString();

    try {
      const handoffs = await this.settlementStore.listHandoffs(query as ListSettlementHandoffsInput);
      const projections = await this.settlementStore.getTradeSettlementProjectionMap(
        [...new Set(handoffs.items.map((item) => item.tradeId))],
      );

      const items = handoffs.items.map((handoff) =>
        mapReconciliationRecord(handoff, projections.get(handoff.tradeId) ?? null),
      );

      return {
        items,
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: handoffs.total,
        },
        freshness: {
          source: 'gateway_settlement_ledger',
          sourceFreshAt: maxTimestamp([
            handoffs.sourceFreshAt,
            ...items.map((item) => item.tradeProjection?.updatedAt ?? null),
          ]),
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      return {
        items: [],
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: 0,
        },
        freshness: {
          source: 'gateway_settlement_ledger',
          sourceFreshAt: null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error),
        },
      };
    }
  }

  async getReconciliationHandoff(handoffId: string): Promise<ReconciliationDetailResult> {
    const queriedAt = this.now().toISOString();

    try {
      const handoff = await this.settlementStore.getHandoff(handoffId);
      if (!handoff) {
        return {
          handoff: null,
          events: [],
          freshness: {
            source: 'gateway_settlement_ledger',
            sourceFreshAt: null,
            queriedAt,
            available: true,
          },
        };
      }

      const [events, projections] = await Promise.all([
        this.settlementStore.listExecutionEvents(handoffId),
        this.settlementStore.getTradeSettlementProjectionMap([handoff.tradeId]),
      ]);

      const tradeProjection = projections.get(handoff.tradeId) ?? null;

      return {
        handoff: mapReconciliationRecord(handoff, tradeProjection),
        events,
        freshness: {
          source: 'gateway_settlement_ledger',
          sourceFreshAt: maxTimestamp([
            handoff.updatedAt,
            tradeProjection?.updatedAt ?? null,
            ...events.map((event) => event.observedAt),
          ]),
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      return {
        handoff: null,
        events: [],
        freshness: {
          source: 'gateway_settlement_ledger',
          sourceFreshAt: null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error),
        },
      };
    }
  }
}
