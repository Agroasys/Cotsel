/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ComplianceDecisionRecord,
  ComplianceStore,
} from './complianceStore';
import type {
  GovernanceActionRecord,
  GovernanceActionStore,
} from './governanceStore';
import type { DashboardTradeSettlementRecord, TradeReadReader } from './tradeReadService';
import type { SettlementStore } from './settlementStore';
import type { RicardianClient, RicardianDocumentRecord } from './ricardianClient';
import { GatewayError } from '../errors';

export interface RicardianFreshness {
  source: 'ricardian_http';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
}

export interface EvidenceFreshness {
  source: 'gateway_ledgers';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
}

export interface RicardianVerificationStatus {
  status: 'verified' | 'mismatch' | 'unavailable';
  tradeHashMatchesDocument: boolean;
  settlementHashMatchesTrade: boolean | null;
}

export interface RicardianDocumentResult {
  tradeId: string;
  ricardianHash: string;
  document: RicardianDocumentRecord | null;
  verification: RicardianVerificationStatus;
  freshness: RicardianFreshness;
}

export interface TradeEvidenceResult {
  tradeId: string;
  ricardianHash: string;
  settlement: DashboardTradeSettlementRecord | null;
  complianceDecisions: ComplianceDecisionRecord[];
  governanceActions: GovernanceActionRecord[];
  freshness: EvidenceFreshness;
}

export interface EvidenceReadReader {
  getRicardianDocument(tradeId: string): Promise<RicardianDocumentResult>;
  getTradeEvidence(tradeId: string): Promise<TradeEvidenceResult>;
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

function degradedReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

async function readAllComplianceDecisions(
  complianceStore: ComplianceStore,
  tradeId: string,
): Promise<ComplianceDecisionRecord[]> {
  const items: ComplianceDecisionRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await complianceStore.listTradeDecisions({ tradeId, limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return items;
}

async function readAllGovernanceActions(
  governanceActionStore: GovernanceActionStore,
  tradeId: string,
): Promise<GovernanceActionRecord[]> {
  const items: GovernanceActionRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await governanceActionStore.list({ tradeId, limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return items;
}

export class EvidenceReadService implements EvidenceReadReader {
  constructor(
    private readonly tradeReadService: TradeReadReader,
    private readonly settlementStore: SettlementStore,
    private readonly ricardianClient: RicardianClient,
    private readonly complianceStore: ComplianceStore,
    private readonly governanceActionStore: GovernanceActionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getRicardianDocument(tradeId: string): Promise<RicardianDocumentResult> {
    const trade = await this.tradeReadService.getTrade(tradeId);
    if (!trade) {
      throw new GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
    }

    if (!trade.ricardianHash) {
      throw new GatewayError(409, 'CONFLICT', 'Trade has no Ricardian hash', {
        tradeId,
        reason: 'missing_ricardian_hash',
      });
    }

    const queriedAt = this.now().toISOString();
    const settlementHandoff = trade.settlement
      ? await this.settlementStore.getHandoff(trade.settlement.handoffId)
      : null;
    const settlementHashMatchesTrade = settlementHandoff?.ricardianHash
      ? settlementHandoff.ricardianHash.toLowerCase() === trade.ricardianHash.toLowerCase()
      : null;

    try {
      const document = await this.ricardianClient.getDocument(trade.ricardianHash);
      const tradeHashMatchesDocument = document.hash.toLowerCase() === trade.ricardianHash.toLowerCase();

      return {
        tradeId,
        ricardianHash: trade.ricardianHash,
        document,
        verification: {
          status: tradeHashMatchesDocument && settlementHashMatchesTrade !== false ? 'verified' : 'mismatch',
          tradeHashMatchesDocument,
          settlementHashMatchesTrade,
        },
        freshness: {
          source: 'ricardian_http',
          sourceFreshAt: document.createdAt,
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      if (error instanceof GatewayError && error.statusCode === 404) {
        throw error;
      }

      return {
        tradeId,
        ricardianHash: trade.ricardianHash,
        document: null,
        verification: {
          status: 'unavailable',
          tradeHashMatchesDocument: false,
          settlementHashMatchesTrade,
        },
        freshness: {
          source: 'ricardian_http',
          sourceFreshAt: null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error, 'Ricardian service is unavailable'),
        },
      };
    }
  }

  async getTradeEvidence(tradeId: string): Promise<TradeEvidenceResult> {
    const trade = await this.tradeReadService.getTrade(tradeId);
    if (!trade) {
      throw new GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
    }

    const queriedAt = this.now().toISOString();

    try {
      const [complianceDecisions, governanceActions] = await Promise.all([
        readAllComplianceDecisions(this.complianceStore, tradeId),
        readAllGovernanceActions(this.governanceActionStore, tradeId),
      ]);

      return {
        tradeId,
        ricardianHash: trade.ricardianHash,
        settlement: trade.settlement,
        complianceDecisions,
        governanceActions,
        freshness: {
          source: 'gateway_ledgers',
          sourceFreshAt: maxTimestamp([
            trade.settlement?.updatedAt ?? null,
            ...complianceDecisions.map((decision) => decision.decidedAt),
            ...governanceActions.flatMap((action) => [action.executedAt, action.createdAt]),
          ]),
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      return {
        tradeId,
        ricardianHash: trade.ricardianHash,
        settlement: trade.settlement,
        complianceDecisions: [],
        governanceActions: [],
        freshness: {
          source: 'gateway_ledgers',
          sourceFreshAt: trade.settlement?.updatedAt ?? null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error, 'Evidence sources are unavailable'),
        },
      };
    }
  }
}
