/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatUnits } from 'ethers';
import { ComplianceStore } from './complianceStore';
import {
  deriveIndexerFreshnessState,
  IndexerFreshnessState,
  IndexerGraphqlClient,
} from './indexerGraphqlClient';
import { GatewayError } from '../errors';
import { buildSettlementTransactionReference } from './transactionReference';
import type {
  SettlementCallbackStatus,
  SettlementEventType,
  SettlementExecutionStatus,
  SettlementReconciliationStatus,
  TradeSettlementProjection,
} from './settlementStore';

export type DashboardTradeStatus = 'locked' | 'stage_1' | 'stage_2' | 'completed' | 'disputed';
export type DashboardComplianceStatus = 'pass' | 'fail' | 'unavailable';

export interface DashboardTradeEventRecord {
  stage: string;
  timestamp: string;
  actor: string;
  txHash?: string;
  explorerUrl?: string | null;
  detail?: string;
}

export interface DashboardTradeRecord {
  id: string;
  buyer: string;
  supplier: string;
  amount: number;
  currency: 'USDC';
  status: DashboardTradeStatus;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
  ricardianHash: string;
  platformFee: number;
  logisticsAmount: number;
  timeline: DashboardTradeEventRecord[];
  complianceStatus: DashboardComplianceStatus;
  settlement: DashboardTradeSettlementRecord | null;
}

export interface DashboardTradeReadFreshness {
  source: 'indexer_graphql';
  state: IndexerFreshnessState;
  queriedAt: string;
  sourceFreshAt: string | null;
  available: boolean;
  lastProcessedBlock: string | null;
  lastTradeEventAt: string | null;
}

export interface DashboardTradeListSnapshot {
  items: DashboardTradeRecord[];
  freshness: DashboardTradeReadFreshness;
}

export interface DashboardTradeDetailSnapshot {
  item: DashboardTradeRecord | null;
  freshness: DashboardTradeReadFreshness;
}

export interface DashboardTradeSettlementRecord {
  handoffId: string;
  platformId: string;
  platformHandoffId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  callbackStatus: SettlementCallbackStatus;
  providerStatus: string | null;
  txHash: string | null;
  explorerUrl?: string | null;
  externalReference: string | null;
  latestEventType: SettlementEventType | null;
  latestEventDetail: string | null;
  latestEventAt: string | null;
  callbackDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TradeGraphQlRecord {
  tradeId: string;
  buyer: string;
  supplier: string;
  status: 'LOCKED' | 'IN_TRANSIT' | 'ARRIVAL_CONFIRMED' | 'FROZEN' | 'CLOSED';
  totalAmountLocked: string;
  logisticsAmount: string;
  platformFeesAmount: string;
  ricardianHash: string;
  createdAt: string;
  arrivalTimestamp?: string | null;
  events?: TradeEventGraphQlRecord[];
}

interface TradeEventGraphQlRecord {
  eventName: string;
  timestamp: string;
  txHash?: string | null;
  totalAmount?: string | null;
  releasedFirstTranche?: string | null;
  releasedLogisticsAmount?: string | null;
  paidPlatformFees?: string | null;
  arrivalTimestamp?: string | null;
  finalTranche?: string | null;
  finalRecipient?: string | null;
  refundedAmount?: string | null;
  refundedTo?: string | null;
  refundedBuyerPrincipal?: string | null;
  claimType?: string | null;
  claimRecipient?: string | null;
  claimAmount?: string | null;
  payoutRecipient?: string | null;
  payoutAmount?: string | null;
  payoutType?: string | null;
}

interface TradesGraphQlResponse {
  data?: {
    trades?: TradeGraphQlRecord[];
    overviewSnapshotById?: IndexerOverviewSnapshot | null;
  };
  errors?: Array<{ message: string }>;
}

interface IndexerOverviewSnapshot {
  lastIndexedAt: string;
  lastProcessedBlock: string;
  lastTradeEventAt: string | null;
}

export interface TradeSettlementReadStore {
  getTradeSettlementProjectionMap(
    tradeIds: string[],
  ): Promise<Map<string, TradeSettlementProjection>>;
}

function assertIsoTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `Indexer returned invalid ${field} timestamp`,
      {
        field,
        value,
      },
    );
  }

  return new Date(value).toISOString();
}

function assertUnixSecondsTimestamp(value: string, field: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `Indexer returned invalid ${field} timestamp`,
      {
        field,
        value,
      },
    );
  }

  const timestamp = new Date(seconds * 1000);
  if (Number.isNaN(timestamp.getTime())) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `Indexer returned invalid ${field} timestamp`,
      {
        field,
        value,
      },
    );
  }

  return timestamp.toISOString();
}

function parseHash(txHash?: string | null): string | undefined {
  const candidate = txHash ?? undefined;
  return candidate && candidate.trim().length > 0 ? candidate : undefined;
}

function asUsdcNumber(raw: string, field: string): number {
  try {
    const formatted = formatUnits(BigInt(raw), 6);
    const value = Number(formatted);
    if (!Number.isFinite(value)) {
      throw new Error('Formatted value is not finite');
    }
    return value;
  } catch (error) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `Indexer returned invalid ${field} amount`,
      {
        field,
        raw,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function mapTradeStatus(status: TradeGraphQlRecord['status']): DashboardTradeStatus {
  switch (status) {
    case 'LOCKED':
      return 'locked';
    case 'IN_TRANSIT':
      return 'stage_1';
    case 'ARRIVAL_CONFIRMED':
      return 'stage_2';
    case 'FROZEN':
      return 'disputed';
    case 'CLOSED':
      return 'completed';
    default:
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned unknown trade status', {
        status,
      });
  }
}

function mapComplianceStatus(result: 'ALLOW' | 'DENY' | null): DashboardComplianceStatus {
  if (result === 'ALLOW') {
    return 'pass';
  }

  if (result === 'DENY') {
    return 'fail';
  }

  return 'unavailable';
}

function mapEventStage(eventName: string): string {
  switch (eventName) {
    case 'TradeLocked':
      return 'Lock';
    case 'FundsReleasedStage1':
      return 'Stage 1 Release';
    case 'PlatformFeesPaidStage1':
      return 'Platform Fee Settlement';
    case 'ArrivalConfirmed':
      return 'Arrival Confirmed';
    case 'FinalTrancheReleased':
      return 'Final Settlement';
    case 'DisputeOpenedByBuyer':
      return 'Dispute Opened';
    case 'TradeCancelledAfterLockTimeout':
      return 'Lock Timeout Refund';
    case 'InTransitTimeoutRefunded':
      return 'Transit Timeout Refund';
    case 'DisputePayout':
      return 'Dispute Payout';
    case 'ClaimableAccrued':
      return 'Claim Accrued';
    default:
      return eventName;
  }
}

function mapEventActor(eventName: string): string {
  switch (eventName) {
    case 'TradeLocked':
    case 'DisputeOpenedByBuyer':
    case 'TradeCancelledAfterLockTimeout':
    case 'InTransitTimeoutRefunded':
      return 'Buyer';
    case 'FundsReleasedStage1':
    case 'ArrivalConfirmed':
    case 'FinalTrancheReleased':
      return 'Oracle';
    case 'PlatformFeesPaidStage1':
    case 'ClaimableAccrued':
      return 'Treasury';
    case 'DisputePayout':
      return 'Governance';
    default:
      return 'Protocol';
  }
}

function mapEventDetail(event: TradeEventGraphQlRecord): string | undefined {
  switch (event.eventName) {
    case 'TradeLocked':
      return event.totalAmount
        ? `Escrow locked for ${asUsdcNumber(event.totalAmount, 'event.totalAmount').toLocaleString()} USDC.`
        : undefined;
    case 'FundsReleasedStage1':
      return `Stage 1 released ${asUsdcNumber(event.releasedFirstTranche ?? '0', 'event.releasedFirstTranche').toLocaleString()} USDC plus ${asUsdcNumber(event.releasedLogisticsAmount ?? '0', 'event.releasedLogisticsAmount').toLocaleString()} USDC logistics.`;
    case 'PlatformFeesPaidStage1':
      return `Platform fees settled: ${asUsdcNumber(event.paidPlatformFees ?? '0', 'event.paidPlatformFees').toLocaleString()} USDC.`;
    case 'ArrivalConfirmed':
      return event.arrivalTimestamp
        ? `Arrival confirmed at ${assertUnixSecondsTimestamp(event.arrivalTimestamp, 'event.arrivalTimestamp')}.`
        : 'Arrival milestone confirmed by oracle.';
    case 'FinalTrancheReleased':
      return `Final tranche released to ${event.finalRecipient ?? 'supplier'} for ${asUsdcNumber(event.finalTranche ?? '0', 'event.finalTranche').toLocaleString()} USDC.`;
    case 'DisputeOpenedByBuyer':
      return 'Buyer opened a dispute within the post-arrival review window.';
    case 'TradeCancelledAfterLockTimeout':
      return `Trade cancelled after lock timeout. Refunded ${asUsdcNumber(event.refundedAmount ?? '0', 'event.refundedAmount').toLocaleString()} USDC to ${event.refundedTo ?? 'buyer'}.`;
    case 'InTransitTimeoutRefunded':
      return `In-transit timeout refund executed for ${asUsdcNumber(event.refundedBuyerPrincipal ?? '0', 'event.refundedBuyerPrincipal').toLocaleString()} USDC.`;
    case 'DisputePayout':
      return `Governance resolved dispute with ${event.payoutType ?? 'unknown'} payout of ${asUsdcNumber(event.payoutAmount ?? '0', 'event.payoutAmount').toLocaleString()} USDC to ${event.payoutRecipient ?? 'recipient'}.`;
    case 'ClaimableAccrued':
      return `Claim accrued: ${event.claimType ?? 'unknown'} for ${event.claimRecipient ?? 'recipient'} (${asUsdcNumber(event.claimAmount ?? '0', 'event.claimAmount').toLocaleString()} USDC).`;
    default:
      return undefined;
  }
}

function mapTimeline(
  events: TradeEventGraphQlRecord[] | undefined,
  explorerBaseUrl?: string | null,
): DashboardTradeEventRecord[] {
  const sorted = [...(events ?? [])].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );

  return sorted.map((event) => {
    const reference = buildSettlementTransactionReference(event.txHash, explorerBaseUrl);
    const eventHash = parseHash(reference.txHash);
    const eventDetail = mapEventDetail(event);
    return {
      stage: mapEventStage(event.eventName),
      timestamp: assertIsoTimestamp(event.timestamp, 'tradeEvent.timestamp'),
      actor: mapEventActor(event.eventName),
      ...(eventHash ? { txHash: eventHash } : {}),
      ...(reference.explorerUrl ? { explorerUrl: reference.explorerUrl } : {}),
      ...(eventDetail ? { detail: eventDetail } : {}),
    };
  });
}

function parseGraphQlResponse(payload: unknown): TradesGraphQlResponse {
  if (!payload || typeof payload !== 'object') {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Indexer returned an invalid GraphQL payload',
    );
  }

  return payload as TradesGraphQlResponse;
}

function readTradesArray(payload: TradesGraphQlResponse): TradeGraphQlRecord[] {
  if (
    !payload.data ||
    typeof payload.data !== 'object' ||
    !('trades' in payload.data) ||
    !Array.isArray(payload.data.trades)
  ) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Indexer returned an invalid GraphQL payload',
    );
  }

  return payload.data.trades;
}

function readOverviewSnapshot(payload: TradesGraphQlResponse): IndexerOverviewSnapshot {
  const snapshot = payload.data?.overviewSnapshotById;
  if (!snapshot) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Indexer returned no overview snapshot for trade freshness',
    );
  }

  if (
    typeof snapshot.lastIndexedAt !== 'string' ||
    !/^\d+$/.test(snapshot.lastProcessedBlock) ||
    (snapshot.lastTradeEventAt !== null && typeof snapshot.lastTradeEventAt !== 'string')
  ) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Indexer returned an invalid overview snapshot for trade freshness',
    );
  }

  return snapshot;
}

function mapTradeFreshness(
  snapshot: IndexerOverviewSnapshot,
  queriedAt: string,
): DashboardTradeReadFreshness {
  const sourceFreshAt = assertIsoTimestamp(
    snapshot.lastIndexedAt,
    'overviewSnapshot.lastIndexedAt',
  );
  return {
    source: 'indexer_graphql',
    state: deriveIndexerFreshnessState(sourceFreshAt, Date.parse(queriedAt)),
    queriedAt,
    sourceFreshAt,
    available: true,
    lastProcessedBlock: snapshot.lastProcessedBlock,
    lastTradeEventAt: snapshot.lastTradeEventAt
      ? assertIsoTimestamp(snapshot.lastTradeEventAt, 'overviewSnapshot.lastTradeEventAt')
      : null,
  };
}

const listTradesQuery = `
  query DashboardTrades($limit: Int!, $offset: Int!) {
    overviewSnapshotById(id: "singleton") {
      lastIndexedAt
      lastProcessedBlock
      lastTradeEventAt
    }
    trades(orderBy: createdAt_DESC, limit: $limit, offset: $offset) {
      tradeId
      buyer
      supplier
      status
      totalAmountLocked
      logisticsAmount
      platformFeesAmount
      ricardianHash
      createdAt
      arrivalTimestamp
      events(orderBy: timestamp_ASC) {
        eventName
        timestamp
        txHash
        totalAmount
        releasedFirstTranche
        releasedLogisticsAmount
        paidPlatformFees
        arrivalTimestamp
        finalTranche
        finalRecipient
        refundedAmount
        refundedTo
        refundedBuyerPrincipal
        claimType
        claimRecipient
        claimAmount
        payoutRecipient
        payoutAmount
        payoutType
      }
    }
  }
`;

const tradeDetailQuery = `
  query DashboardTradeDetail($tradeId: String!) {
    overviewSnapshotById(id: "singleton") {
      lastIndexedAt
      lastProcessedBlock
      lastTradeEventAt
    }
    trades(where: { tradeId_eq: $tradeId }, limit: 1) {
      tradeId
      buyer
      supplier
      status
      totalAmountLocked
      logisticsAmount
      platformFeesAmount
      ricardianHash
      createdAt
      arrivalTimestamp
      events(orderBy: timestamp_ASC) {
        eventName
        timestamp
        txHash
        totalAmount
        releasedFirstTranche
        releasedLogisticsAmount
        paidPlatformFees
        arrivalTimestamp
        finalTranche
        finalRecipient
        refundedAmount
        refundedTo
        refundedBuyerPrincipal
        claimType
        claimRecipient
        claimAmount
        payoutRecipient
        payoutAmount
        payoutType
      }
    }
  }
`;

export interface TradeReadReader {
  checkReadiness(): Promise<void>;
  listTradesSnapshot(limit?: number, offset?: number): Promise<DashboardTradeListSnapshot>;
  listTrades(limit?: number, offset?: number): Promise<DashboardTradeRecord[]>;
  getTradeSnapshot(tradeId: string): Promise<DashboardTradeDetailSnapshot>;
  getTrade(tradeId: string): Promise<DashboardTradeRecord | null>;
}

export class TradeReadService implements TradeReadReader {
  private readonly indexerClient: IndexerGraphqlClient;
  private readonly complianceStore: ComplianceStore;
  private readonly settlementReadStore?: TradeSettlementReadStore;
  private readonly explorerBaseUrl?: string | null;

  constructor(
    indexerClientOrUrl: IndexerGraphqlClient | string,
    indexerRequestTimeoutOrComplianceStore: number | ComplianceStore,
    complianceStoreOrSettlementStore?: ComplianceStore | TradeSettlementReadStore,
    maybeSettlementReadStoreOrExplorerBaseUrl?: TradeSettlementReadStore | string | null,
    maybeExplorerBaseUrl?: string | null,
  ) {
    if (typeof indexerClientOrUrl === 'string') {
      this.indexerClient = new IndexerGraphqlClient(
        indexerClientOrUrl,
        indexerRequestTimeoutOrComplianceStore as number,
      );
      this.complianceStore = complianceStoreOrSettlementStore as ComplianceStore;
      this.settlementReadStore =
        typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
          ? undefined
          : (maybeSettlementReadStoreOrExplorerBaseUrl ?? undefined);
      this.explorerBaseUrl =
        typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
          ? maybeSettlementReadStoreOrExplorerBaseUrl
          : maybeExplorerBaseUrl;
      return;
    }

    this.indexerClient = indexerClientOrUrl;
    this.complianceStore = indexerRequestTimeoutOrComplianceStore as ComplianceStore;
    this.settlementReadStore = complianceStoreOrSettlementStore as
      | TradeSettlementReadStore
      | undefined;
    this.explorerBaseUrl =
      typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
        ? maybeSettlementReadStoreOrExplorerBaseUrl
        : maybeExplorerBaseUrl;
  }

  async checkReadiness(): Promise<void> {
    const response = await this.executeQuery(
      'DashboardGatewayTradeReadiness',
      'query DashboardGatewayTradeReadiness { trades(limit: 1) { tradeId } }',
    );
    readTradesArray(response);
  }

  async listTradesSnapshot(limit = 100, offset = 0): Promise<DashboardTradeListSnapshot> {
    const response = await this.executeQuery('DashboardTrades', listTradesQuery, { limit, offset });
    const trades = readTradesArray(response);
    const freshness = mapTradeFreshness(readOverviewSnapshot(response), new Date().toISOString());
    const settlementProjectionMap = this.settlementReadStore
      ? await this.settlementReadStore.getTradeSettlementProjectionMap(
          trades.map((trade) => trade.tradeId),
        )
      : new Map<string, TradeSettlementProjection>();

    return {
      items: await Promise.all(
        trades.map((trade) =>
          this.mapTradeRecord(trade, settlementProjectionMap.get(trade.tradeId) ?? null),
        ),
      ),
      freshness,
    };
  }

  async listTrades(limit = 100, offset = 0): Promise<DashboardTradeRecord[]> {
    return (await this.listTradesSnapshot(limit, offset)).items;
  }

  async getTradeSnapshot(tradeId: string): Promise<DashboardTradeDetailSnapshot> {
    const response = await this.executeQuery('DashboardTradeDetail', tradeDetailQuery, { tradeId });
    const freshness = mapTradeFreshness(readOverviewSnapshot(response), new Date().toISOString());
    const trade = readTradesArray(response)[0];
    if (!trade) {
      return {
        item: null,
        freshness,
      };
    }

    const settlementProjectionMap = this.settlementReadStore
      ? await this.settlementReadStore.getTradeSettlementProjectionMap([trade.tradeId])
      : new Map<string, TradeSettlementProjection>();

    return {
      item: await this.mapTradeRecord(trade, settlementProjectionMap.get(trade.tradeId) ?? null),
      freshness,
    };
  }

  async getTrade(tradeId: string): Promise<DashboardTradeRecord | null> {
    return (await this.getTradeSnapshot(tradeId)).item;
  }

  private async mapTradeRecord(
    trade: TradeGraphQlRecord,
    settlementProjection: TradeSettlementProjection | null,
  ): Promise<DashboardTradeRecord> {
    const timeline = mapTimeline(trade.events, this.explorerBaseUrl);
    const lockReference =
      timeline.find((event) => event.stage === 'Lock' && event.txHash)?.txHash ??
      timeline.find((event) => event.txHash)?.txHash ??
      null;
    const compliance = await this.complianceStore.getTradeStatus(trade.tradeId);
    const latestTimelineEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const updatedAt =
      latestTimelineEntry?.timestamp ?? assertIsoTimestamp(trade.createdAt, 'trade.createdAt');
    const settlementReference = buildSettlementTransactionReference(
      settlementProjection?.txHash ?? null,
      this.explorerBaseUrl,
    );

    return {
      id: trade.tradeId,
      buyer: trade.buyer,
      supplier: trade.supplier,
      amount: asUsdcNumber(trade.totalAmountLocked, 'trade.totalAmountLocked'),
      currency: 'USDC',
      status: mapTradeStatus(trade.status),
      txHash: lockReference,
      createdAt: assertIsoTimestamp(trade.createdAt, 'trade.createdAt'),
      updatedAt,
      ricardianHash: trade.ricardianHash,
      platformFee: asUsdcNumber(trade.platformFeesAmount, 'trade.platformFeesAmount'),
      logisticsAmount: asUsdcNumber(trade.logisticsAmount, 'trade.logisticsAmount'),
      timeline,
      complianceStatus: mapComplianceStatus(compliance?.currentResult ?? null),
      settlement: settlementProjection
        ? {
            handoffId: settlementProjection.handoffId,
            platformId: settlementProjection.platformId,
            platformHandoffId: settlementProjection.platformHandoffId,
            phase: settlementProjection.phase,
            settlementChannel: settlementProjection.settlementChannel,
            displayCurrency: settlementProjection.displayCurrency,
            displayAmount: settlementProjection.displayAmount,
            executionStatus: settlementProjection.executionStatus,
            reconciliationStatus: settlementProjection.reconciliationStatus,
            callbackStatus: settlementProjection.callbackStatus,
            providerStatus: settlementProjection.providerStatus,
            txHash: settlementReference.txHash,
            ...(settlementReference.explorerUrl
              ? { explorerUrl: settlementReference.explorerUrl }
              : {}),
            externalReference: settlementProjection.externalReference,
            latestEventType: settlementProjection.latestEventType,
            latestEventDetail: settlementProjection.latestEventDetail,
            latestEventAt: settlementProjection.latestEventAt,
            callbackDeliveredAt: settlementProjection.callbackDeliveredAt,
            createdAt: settlementProjection.createdAt,
            updatedAt: settlementProjection.updatedAt,
          }
        : null,
    };
  }

  private async executeQuery(
    operationName: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<TradesGraphQlResponse> {
    return parseGraphQlResponse(await this.indexerClient.query(operationName, query, variables));
  }
}
