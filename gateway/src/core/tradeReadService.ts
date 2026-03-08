/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatUnits } from 'ethers';
import { ComplianceStore } from './complianceStore';
import { GatewayError } from '../errors';

export type DashboardTradeStatus = 'locked' | 'stage_1' | 'stage_2' | 'completed' | 'disputed';
export type DashboardComplianceStatus = 'pass' | 'fail' | 'unavailable';

export interface DashboardTradeEventRecord {
  stage: string;
  timestamp: string;
  actor: string;
  txHash?: string;
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
  extrinsicHash?: string | null;
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
  };
  errors?: Array<{ message: string }>;
}

function assertIsoTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
      field,
      value,
    });
  }

  return new Date(value).toISOString();
}

function assertUnixSecondsTimestamp(value: string, field: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
      field,
      value,
    });
  }

  const timestamp = new Date(seconds * 1000);
  if (Number.isNaN(timestamp.getTime())) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
      field,
      value,
    });
  }

  return timestamp.toISOString();
}

function parseHash(txHash?: string | null, extrinsicHash?: string | null): string | undefined {
  const candidate = txHash ?? extrinsicHash ?? undefined;
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
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} amount`, {
      field,
      raw,
      reason: error instanceof Error ? error.message : String(error),
    });
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
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned unknown trade status', { status });
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
      return event.totalAmount ? `Escrow locked for ${asUsdcNumber(event.totalAmount, 'event.totalAmount').toLocaleString()} USDC.` : undefined;
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

function mapTimeline(events: TradeEventGraphQlRecord[] | undefined): DashboardTradeEventRecord[] {
  const sorted = [...(events ?? [])].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );

  return sorted.map((event) => {
    const eventHash = parseHash(event.txHash, event.extrinsicHash);
    const eventDetail = mapEventDetail(event);
    return {
      stage: mapEventStage(event.eventName),
      timestamp: assertIsoTimestamp(event.timestamp, 'tradeEvent.timestamp'),
      actor: mapEventActor(event.eventName),
      ...(eventHash ? { txHash: eventHash } : {}),
      ...(eventDetail ? { detail: eventDetail } : {}),
    };
  });
}

function parseGraphQlResponse(payload: unknown): TradesGraphQlResponse {
  if (!payload || typeof payload !== 'object') {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned an invalid GraphQL payload');
  }

  return payload as TradesGraphQlResponse;
}

function readTradesArray(payload: TradesGraphQlResponse): TradeGraphQlRecord[] {
  if (!payload.data || typeof payload.data !== 'object' || !('trades' in payload.data) || !Array.isArray(payload.data.trades)) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned an invalid GraphQL payload');
  }

  return payload.data.trades;
}

const listTradesQuery = `
  query DashboardTrades($limit: Int!, $offset: Int!) {
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
        extrinsicHash
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
        extrinsicHash
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
  listTrades(limit?: number, offset?: number): Promise<DashboardTradeRecord[]>;
  getTrade(tradeId: string): Promise<DashboardTradeRecord | null>;
}

export class TradeReadService implements TradeReadReader {
  constructor(
    private readonly indexerGraphqlUrl: string,
    private readonly indexerRequestTimeoutMs: number,
    private readonly complianceStore: ComplianceStore,
  ) {}

  async checkReadiness(): Promise<void> {
    const response = await this.executeQuery(
      'DashboardGatewayTradeReadiness',
      'query DashboardGatewayTradeReadiness { trades(limit: 1) { tradeId } }',
    );
    readTradesArray(response);
  }

  async listTrades(limit = 100, offset = 0): Promise<DashboardTradeRecord[]> {
    const response = await this.executeQuery('DashboardTrades', listTradesQuery, { limit, offset });
    const trades = readTradesArray(response);
    return Promise.all(trades.map((trade) => this.mapTradeRecord(trade)));
  }

  async getTrade(tradeId: string): Promise<DashboardTradeRecord | null> {
    const response = await this.executeQuery('DashboardTradeDetail', tradeDetailQuery, { tradeId });
    const trade = readTradesArray(response)[0];
    if (!trade) {
      return null;
    }

    return this.mapTradeRecord(trade);
  }

  private async mapTradeRecord(trade: TradeGraphQlRecord): Promise<DashboardTradeRecord> {
    const timeline = mapTimeline(trade.events);
    const lockReference = timeline.find((event) => event.stage === 'Lock' && event.txHash)?.txHash
      ?? timeline.find((event) => event.txHash)?.txHash
      ?? null;
    const compliance = await this.complianceStore.getTradeStatus(trade.tradeId);
    const latestTimelineEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const updatedAt = latestTimelineEntry?.timestamp ?? assertIsoTimestamp(trade.createdAt, 'trade.createdAt');

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
    };
  }

  private async executeQuery(
    operationName: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<TradesGraphQlResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.indexerRequestTimeoutMs);

    try {
      const response = await fetch(this.indexerGraphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName, query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
          operationName,
          status: response.status,
        });
      }

      const payload = parseGraphQlResponse(await response.json());
      if (payload.errors?.length) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
          operationName,
          errors: payload.errors.map((error) => error.message),
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Indexer request timed out', {
          operationName,
          timeoutMs: this.indexerRequestTimeoutMs,
        });
      }

      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer request failed', {
        operationName,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
