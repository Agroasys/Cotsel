import {
  createManagedRpcProvider,
  isTreasuryConfirmationStage,
  resolveSettlementConfirmationStage,
  SettlementConfirmationState,
} from '@agroasys/sdk';
import { config } from '../config';
import { LedgerEntryWithState, PayoutState, TreasuryEntryEligibility } from '../types';
import { ReconciliationGateService, type TradeReconciliationGate } from './reconciliationGate';

const EXPORTABLE_STATES: ReadonlySet<PayoutState> = new Set([
  'READY_FOR_PARTNER_SUBMISSION',
  'AWAITING_PARTNER_UPDATE',
  'PARTNER_REPORTED_COMPLETED',
]);

interface SettlementHeadProvider {
  getBlock(tag: 'latest' | 'safe' | 'finalized'): Promise<{ number: bigint | number } | null>;
}

interface ReconciliationGateReader {
  assessTrades(tradeIds: string[]): Promise<Map<string, TradeReconciliationGate>>;
}

function buildBlockedReasons(input: {
  latestState: PayoutState | null;
  confirmationState: SettlementConfirmationState | null;
  reconciliationStatus: TreasuryEntryEligibility['reconciliationStatus'];
  confirmationFailureReason: string | null;
  reconciliationBlockedReasons: string[];
}): string[] {
  const reasons: string[] = [];

  if (input.confirmationFailureReason) {
    reasons.push(input.confirmationFailureReason);
  } else if (
    !input.confirmationState ||
    !isTreasuryConfirmationStage(input.confirmationState.stage)
  ) {
    reasons.push(
      `Entry has not reached Base finalized stage${input.confirmationState ? ` (current stage: ${input.confirmationState.stage})` : ''}`,
    );
  }

  if (input.reconciliationStatus !== 'CLEAR') {
    reasons.push(...input.reconciliationBlockedReasons);
  }

  return Array.from(new Set(reasons));
}

function isExportableState(state: PayoutState | null): boolean {
  return state !== null && EXPORTABLE_STATES.has(state);
}

export class TreasuryEligibilityService {
  private readonly provider: SettlementHeadProvider | null;
  private readonly reconciliationGate: ReconciliationGateReader;

  constructor(deps?: {
    provider?: SettlementHeadProvider | null;
    reconciliationGate?: ReconciliationGateReader;
  }) {
    this.provider =
      deps?.provider ??
      (config.rpcUrl && config.chainId
        ? createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
            chainId: config.chainId,
          })
        : null);
    this.reconciliationGate = deps?.reconciliationGate ?? new ReconciliationGateService();
  }

  private async getConfirmationState(blockNumber: number): Promise<{
    state: SettlementConfirmationState | null;
    failureReason: string | null;
  }> {
    if (!this.provider) {
      return {
        state: null,
        failureReason: 'Settlement runtime is not configured for treasury confirmation checks',
      };
    }

    const [latestBlock, safeBlock, finalizedBlock] = await Promise.all([
      this.provider.getBlock('latest'),
      this.provider.getBlock('safe'),
      this.provider.getBlock('finalized'),
    ]);

    if (!latestBlock) {
      return {
        state: null,
        failureReason:
          'Managed RPC provider returned no latest block for treasury confirmation checks',
      };
    }

    return {
      state: resolveSettlementConfirmationStage(blockNumber, {
        latestBlockNumber: Number(latestBlock.number),
        safeBlockNumber: safeBlock ? Number(safeBlock.number) : null,
        finalizedBlockNumber: finalizedBlock ? Number(finalizedBlock.number) : null,
      }),
      failureReason: null,
    };
  }

  async assessEntries(
    entries: LedgerEntryWithState[],
  ): Promise<Map<number, TreasuryEntryEligibility>> {
    const gates = new Map<number, TreasuryEntryEligibility>();
    if (entries.length === 0) {
      return gates;
    }

    const reconciliationByTradeId = await this.reconciliationGate.assessTrades(
      entries.map((entry) => entry.trade_id),
    );

    for (const entry of entries) {
      const confirmation = await this.getConfirmationState(entry.block_number);
      const reconciliationGate = reconciliationByTradeId.get(entry.trade_id) ?? {
        tradeId: entry.trade_id,
        status: 'UNKNOWN',
        runKey: null,
        driftCount: 0,
        blockedReasons: ['Reconciliation status could not be determined'],
      };
      const blockedReasons = buildBlockedReasons({
        latestState: entry.latest_state,
        confirmationState: confirmation.state,
        confirmationFailureReason: confirmation.failureReason,
        reconciliationStatus: reconciliationGate.status,
        reconciliationBlockedReasons: reconciliationGate.blockedReasons,
      });
      const eligibleForPayout = blockedReasons.length === 0;
      const eligibleForExport = eligibleForPayout && isExportableState(entry.latest_state);

      gates.set(entry.id, {
        entryId: entry.id,
        tradeId: entry.trade_id,
        payoutState: entry.latest_state,
        confirmationStage: confirmation.state?.stage ?? null,
        latestBlockNumber: confirmation.state?.latestBlockNumber ?? null,
        safeBlockNumber: confirmation.state?.safeBlockNumber ?? null,
        finalizedBlockNumber: confirmation.state?.finalizedBlockNumber ?? null,
        reconciliationStatus: reconciliationGate.status,
        reconciliationRunKey: reconciliationGate.runKey,
        eligibleForPayout,
        eligibleForExport,
        blockedReasons,
      });
    }

    return gates;
  }
}
