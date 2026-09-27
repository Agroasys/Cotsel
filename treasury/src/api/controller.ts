import { Request, Response } from 'express';
import {
  failure,
  HttpError,
  optionalEnum,
  optionalInteger,
  optionalNullableString,
  optionalRecord,
  optionalString,
  requireInteger,
  requireIsoTimestamp,
  requireObject,
  requireString,
  success,
} from '@agroasys/shared-http';
import { assertBankPayoutState, BankPayoutConflictError } from '../core/bankPayout';
import { TreasuryEligibilityService } from '../core/exportEligibility';
import {
  assertCompleteExportDelivery,
  ExportRequestError,
  parseExportRequest,
} from '../core/ledgerExport';
import { loadLedgerExportPage } from '../core/ledgerExportService';
import { actorFor, optionalActorFor } from './actorBinding';
import { mapValidationError } from './errorMapping';
import { resolveRealizationBinding } from './realizationBinding';
import { SweepBatchGate } from './sweepBatchGate';
import type {
  AddSweepBatchEntryBody,
  AppendStateBody,
  AppendTreasuryPartnerHandoffEvidenceBody,
  CreateAccountingPeriodBody,
  CreateRevenueRealizationBody,
  CreateSweepBatchBody,
  UpdateAccountingPeriodStatusBody,
  UpdateSweepBatchStatusBody,
  UpsertBankConfirmationBody,
  UpsertDepositBody,
  UpsertPartnerHandoffBody,
  UpsertTreasuryPartnerHandoffBody,
} from './requestBodies';
import { toCsv } from './ledgerCsv';
import { TreasuryIngestionWorker } from '../core/ingestionWorker';
import { isHandedOff, isProviderHandoffStatus } from '../core/providerHandoffAuthority';
import { ReconciliationGateService } from '../core/reconciliationGate';
import { SweepExecutionMatcherService } from '../core/sweepExecutionMatcher';
import {
  loadTreasuryAccountingPeriodClosePacket,
  loadTreasuryBatchTraceReport,
  renderTreasuryAccountingPeriodClosePacketMarkdown,
} from '../core/closeReporting';
import { assertFiatDepositState, FiatDepositConflictError } from '../core/fiatDeposit';
import { assertValidTransition } from '../core/payout';
import type { ChainCanonicalityState, LedgerChainReorgEvent } from '../core/chainCanonicality';
import {
  appendPayoutState,
  addSweepBatchEntry,
  appendTreasuryPartnerHandoffEvidence,
  createAccountingPeriod,
  createRevenueRealization,
  createSweepBatch,
  getTreasuryPartnerHandoffByLedgerEntryId,
  listTreasuryPartnerHandoffEventsByLedgerEntryId,
  listLedgerEntryAccountingProjections,
  getLedgerEntryAccountingProjection,
  getLatestPayoutState,
  getLedgerEntries,
  getLedgerEntryById,
  getSweepBatchDetail,
  countLedgerEntriesByCanonicality,
  getIngestionStableBlock,
  listChainReorgEvents,
  listDistinctLedgerTradeIds,
  listAccountingPeriods,
  listSweepBatches,
  updateAccountingPeriodStatus,
  updateSweepBatchStatus,
  upsertPartnerHandoff,
  upsertBankPayoutConfirmation,
  upsertFiatDepositReference,
  upsertTreasuryPartnerHandoff,
} from '../database/queries';
import { TreasuryPartnerHandoffConflictError } from '../core/treasuryPartnerHandoff';
import {
  AccountingPeriodStatus,
  PayoutState,
  SweepBatchStatus,
  TreasuryAccountingState,
  TreasuryPartnerCode,
  TreasuryPartnerHandoffStatus,
} from '../types';

const PAYOUT_STATES: PayoutState[] = [
  'PENDING_REVIEW',
  'READY_FOR_EXTERNAL_HANDOFF',
  'AWAITING_EXTERNAL_CONFIRMATION',
  'EXTERNAL_EXECUTION_CONFIRMED',
  'CANCELLED',
];

const EXPORT_FORMATS = ['json', 'csv'] as const;
const CLOSE_PACKET_FORMATS = ['json', 'markdown'] as const;
const ACCOUNTING_PERIOD_STATUSES: AccountingPeriodStatus[] = ['OPEN', 'PENDING_CLOSE', 'CLOSED'];
const SWEEP_BATCH_STATUSES: SweepBatchStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTED',
  'HANDED_OFF',
  'CLOSED',
  'VOID',
];
const TREASURY_PARTNER_CODES: TreasuryPartnerCode[] = ['bridge'];
const ACCOUNTING_STATES: TreasuryAccountingState[] = [
  'HELD',
  'ALLOCATED_TO_SWEEP',
  'SWEPT',
  'HANDED_OFF',
  'REALIZED',
  'EXCEPTION',
];

export type EligibilitySummary = {
  confirmationStage: string | null;
  latestBlockNumber: number | null;
  safeBlockNumber: number | null;
  finalizedBlockNumber: number | null;
  reconciliationStatus: string;
  reconciliationRunKey: string | null;
  reconciliationFreshness: 'FRESH' | 'STALE' | 'MISSING';
  reconciliationCompletedAt: string | null;
  staleRunningRunCount: number;
  canonicalityState: ChainCanonicalityState;
  canonicalityDepth: number | null;
  canonicalityStableBlockNumber: number | null;
  eligibleForPayout: boolean;
  eligibleForExport: boolean;
  blockedReasons: string[];
};

function fallbackEligibility(): EligibilitySummary {
  return {
    confirmationStage: null,
    latestBlockNumber: null,
    safeBlockNumber: null,
    finalizedBlockNumber: null,
    reconciliationStatus: 'UNKNOWN',
    reconciliationRunKey: null,
    reconciliationFreshness: 'MISSING',
    reconciliationCompletedAt: null,
    staleRunningRunCount: 0,
    canonicalityState: 'UNVERIFIED',
    canonicalityDepth: null,
    canonicalityStableBlockNumber: null,
    eligibleForPayout: false,
    eligibleForExport: false,
    blockedReasons: ['Eligibility state unavailable'],
  };
}

function serializeEligibility(
  eligibility:
    | EligibilitySummary
    | {
        confirmationStage: string | null;
        latestBlockNumber: number | null;
        safeBlockNumber: number | null;
        finalizedBlockNumber: number | null;
        reconciliationStatus: string;
        reconciliationRunKey: string | null;
        reconciliationFreshness: 'FRESH' | 'STALE' | 'MISSING';
        reconciliationCompletedAt: Date | null;
        staleRunningRunCount: number;
        canonicalityState: ChainCanonicalityState;
        canonicalityDepth: number | null;
        canonicalityStableBlockNumber: number | null;
        eligibleForPayout: boolean;
        eligibleForExport: boolean;
        blockedReasons: string[];
      },
): EligibilitySummary {
  return {
    confirmationStage: eligibility.confirmationStage,
    latestBlockNumber: eligibility.latestBlockNumber,
    safeBlockNumber: eligibility.safeBlockNumber,
    finalizedBlockNumber: eligibility.finalizedBlockNumber,
    reconciliationStatus: eligibility.reconciliationStatus,
    reconciliationRunKey: eligibility.reconciliationRunKey,
    reconciliationFreshness: eligibility.reconciliationFreshness,
    reconciliationCompletedAt:
      eligibility.reconciliationCompletedAt instanceof Date
        ? eligibility.reconciliationCompletedAt.toISOString()
        : eligibility.reconciliationCompletedAt,
    staleRunningRunCount: eligibility.staleRunningRunCount,
    canonicalityState: eligibility.canonicalityState,
    canonicalityDepth: eligibility.canonicalityDepth,
    canonicalityStableBlockNumber: eligibility.canonicalityStableBlockNumber,
    eligibleForPayout: eligibility.eligibleForPayout,
    eligibleForExport: eligibility.eligibleForExport,
    blockedReasons: eligibility.blockedReasons,
  };
}

const CHAIN_REORG_EVIDENCE_LIMIT = 100;

function serializeChainReorgEvent(event: LedgerChainReorgEvent): Record<string, unknown> {
  return {
    id: event.id,
    ledgerEntryId: event.ledger_entry_id,
    entryKey: event.entry_key,
    tradeId: event.trade_id,
    txHash: event.tx_hash,
    blockNumber: event.block_number,
    expectedBlockHash: event.expected_block_hash,
    observedBlockHash: event.observed_block_hash,
    observedBlockNumber: event.observed_block_number,
    observedLogIndex: event.observed_log_index,
    reorgDepth: event.reorg_depth,
    stableBlockNumber: event.stable_block_number,
    mismatchReason: event.mismatch_reason,
    detail: event.detail,
    detectedAt: event.detected_at.toISOString(),
  };
}

function serializeReconciliationControlSummary(summary: {
  status: 'CLEAR' | 'BLOCKED' | 'STALE' | 'MISSING' | 'UNKNOWN';
  freshness: 'FRESH' | 'STALE' | 'MISSING';
  latestCompletedRunKey: string | null;
  latestCompletedRunAt: Date | null;
  latestCompletedRunAgeSeconds: number | null;
  coverageToBlock: number | null;
  coverageComplete: boolean | null;
  staleRunningRunCount: number;
  trackedTradeCount: number;
  clearTradeCount: number;
  blockedTradeCount: number;
  unknownTradeCount: number;
  driftBlockedTradeCount: number;
  blockedReasons: string[];
}) {
  return {
    status: summary.status,
    freshness: summary.freshness,
    latestCompletedRunKey: summary.latestCompletedRunKey,
    latestCompletedRunAt:
      summary.latestCompletedRunAt instanceof Date
        ? summary.latestCompletedRunAt.toISOString()
        : summary.latestCompletedRunAt,
    latestCompletedRunAgeSeconds: summary.latestCompletedRunAgeSeconds,
    // WP-4 H-25. The operator-facing summary names the exact block the accepted
    // run reached, not just how recent it was.
    coverageToBlock: summary.coverageToBlock,
    coverageComplete: summary.coverageComplete,
    staleRunningRunCount: summary.staleRunningRunCount,
    trackedTradeCount: summary.trackedTradeCount,
    clearTradeCount: summary.clearTradeCount,
    blockedTradeCount: summary.blockedTradeCount,
    unknownTradeCount: summary.unknownTradeCount,
    driftBlockedTradeCount: summary.driftBlockedTradeCount,
    blockedReasons: summary.blockedReasons,
  };
}

function parseEntryId(value: unknown): number {
  return requireInteger(value, 'entryId', { min: 1 });
}

function parsePeriodId(value: unknown): number {
  return requireInteger(value, 'periodId', { min: 1 });
}

function parseBatchId(value: unknown): number {
  return requireInteger(value, 'batchId', { min: 1 });
}

function parseObservedAt(value: unknown, field: string): Date {
  return requireIsoTimestamp(value, field);
}

function buildFailure(
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return {
    ...failure(code, message),
    ...(extra ?? {}),
  };
}

function assertPayoutState(value: string): asserts value is PayoutState {
  if (!PAYOUT_STATES.includes(value as PayoutState)) {
    throw new HttpError(400, 'ValidationError', 'state must be a valid payout state');
  }
}

function assertTreasuryPartnerCode(value: string): asserts value is TreasuryPartnerCode {
  if (!TREASURY_PARTNER_CODES.includes(value as TreasuryPartnerCode)) {
    throw new HttpError(
      400,
      'ValidationError',
      'partnerCode must be a valid treasury partner code',
    );
  }
}

function assertTreasuryPartnerHandoffStatus(
  value: string,
): asserts value is TreasuryPartnerHandoffStatus {
  if (!isProviderHandoffStatus(value)) {
    throw new HttpError(
      400,
      'ValidationError',
      'partnerStatus must be a valid treasury partner handoff status',
    );
  }
}

export class TreasuryController {
  private readonly ingestion = new TreasuryIngestionWorker();
  private readonly eligibility = new TreasuryEligibilityService();
  private readonly reconciliationGate = new ReconciliationGateService();
  private readonly sweepExecutionMatcher = new SweepExecutionMatcherService();
  private readonly sweepGate = new SweepBatchGate(this.eligibility);

  async ingest(_req: Request, res: Response): Promise<void> {
    try {
      const run = await this.ingestion.runOnce('API');

      // Declining the lease is not an error and not coverage. The scheduled
      // owner is mid-run, so the caller should retry rather than treat this
      // request as the run that proved the window.
      if (run.outcome === 'NOT_OWNER') {
        res
          .status(409)
          .json(
            failure(
              'IngestionLeaseHeld',
              'Another treasury replica holds the ingestion lease; retry after the current run completes',
            ),
          );
        return;
      }

      // A capped run read what it claims to have read and is not a refusal.
      // The caller is told the window was not exhausted so it can ask again
      // rather than record the range as covered.
      if (run.outcome === 'PARTIAL') {
        res.status(200).json(success({ runKey: run.runKey, ...run.result }));
        return;
      }

      if (run.outcome !== 'COMPLETED') {
        // A refusal is not a successful empty run. An operator reading 200 here
        // would record "ingestion completed, nothing new" for a run that never
        // reached the chain, which is the false-green this control removes.
        res
          .status(503)
          .json(
            failure(
              'SettlementUnavailable',
              run.result?.blockedReason ?? run.error ?? 'Ingestion did not complete',
            ),
          );
        return;
      }

      res.status(200).json(success({ runKey: run.runKey, ...run.result }));
    } catch (error: unknown) {
      res
        .status(500)
        .json(
          failure('InternalError', error instanceof Error ? error.message : 'Ingestion failed'),
        );
    }
  }

  async listEntries(req: Request, res: Response): Promise<void> {
    try {
      const tradeId = optionalString(req.query.tradeId, 'tradeId');
      const state = optionalEnum(req.query.state, PAYOUT_STATES, 'state');
      const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 500 }) ?? 50;
      const offset = optionalInteger(req.query.offset, 'offset', { min: 0 }) ?? 0;

      const entries = await getLedgerEntries({ tradeId, state, limit, offset });
      const eligibility = await this.eligibility.assessEntries(entries);
      const data = entries.map((entry) => ({
        ...entry,
        ...(eligibility.has(entry.id)
          ? serializeEligibility(eligibility.get(entry.id)!)
          : fallbackEligibility()),
      }));

      res.status(200).json(success(data));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to list entries');
      res.status(response.statusCode).json(response.body);
    }
  }

  /**
   * WP-4 FAIL-06 evidence surface. Answers, at one named stable block, how much
   * of the ledger is provably on the chain, how much has been revoked, and what
   * each revocation observed. The reorganization drill reads this before and
   * after the orphaning to show eligibility was removed rather than assumed.
   */
  async getChainCanonicalitySummary(_req: Request, res: Response): Promise<void> {
    try {
      const [counts, stableBlockNumber, reorgEvents] = await Promise.all([
        countLedgerEntriesByCanonicality(),
        getIngestionStableBlock(),
        listChainReorgEvents({ limit: CHAIN_REORG_EVIDENCE_LIMIT }),
      ]);

      res.status(200).json(
        success({
          stableBlockNumber,
          counts,
          reorgEvents: reorgEvents.map(serializeChainReorgEvent),
        }),
      );
    } catch (error: unknown) {
      res
        .status(500)
        .json(
          failure(
            'InternalError',
            error instanceof Error ? error.message : 'Failed to read chain canonicality summary',
          ),
        );
    }
  }

  async getReconciliationControlSummary(_req: Request, res: Response): Promise<void> {
    try {
      const tradeIds = await listDistinctLedgerTradeIds();
      const summary = await this.reconciliationGate.summarizeTrades(tradeIds);
      res.status(200).json(success(serializeReconciliationControlSummary(summary)));
    } catch (error: unknown) {
      res
        .status(500)
        .json(
          failure(
            'InternalError',
            error instanceof Error
              ? error.message
              : 'Failed to read reconciliation control summary',
          ),
        );
    }
  }

  async listAccountingPeriods(req: Request, res: Response): Promise<void> {
    try {
      const status = optionalEnum(req.query.status, ACCOUNTING_PERIOD_STATUSES, 'status');
      const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
      const offset = optionalInteger(req.query.offset, 'offset', { min: 0 }) ?? 0;

      const periods = await listAccountingPeriods({ status, limit, offset });
      res.status(200).json(success(periods));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to list accounting periods');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getAccountingPeriodRollforward(
    req: Request<{ periodId: string }>,
    res: Response,
  ): Promise<void> {
    try {
      const periodId = parsePeriodId(req.params.periodId);
      const packet = await loadTreasuryAccountingPeriodClosePacket(
        periodId,
        this.reconciliationGate,
      );
      res.status(200).json(success(packet.rollforward));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to build accounting period rollforward');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getAccountingPeriodClosePacket(
    req: Request<{ periodId: string }>,
    res: Response,
  ): Promise<void> {
    try {
      const periodId = parsePeriodId(req.params.periodId);
      const format = optionalEnum(req.query.format, CLOSE_PACKET_FORMATS, 'format') ?? 'json';
      const packet = await loadTreasuryAccountingPeriodClosePacket(
        periodId,
        this.reconciliationGate,
      );

      if (format === 'markdown') {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.status(200).send(renderTreasuryAccountingPeriodClosePacketMarkdown(packet));
        return;
      }

      res.status(200).json(success(packet));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to build accounting period close packet');
      res.status(response.statusCode).json(response.body);
    }
  }

  async listEntryAccounting(req: Request, res: Response): Promise<void> {
    try {
      const accountingState = optionalEnum(
        req.query.accountingState,
        ACCOUNTING_STATES,
        'accountingState',
      );
      const accountingPeriodId =
        req.query.accountingPeriodId === undefined
          ? undefined
          : requireInteger(req.query.accountingPeriodId, 'accountingPeriodId', { min: 1 });
      const sweepBatchId =
        req.query.sweepBatchId === undefined
          ? undefined
          : requireInteger(req.query.sweepBatchId, 'sweepBatchId', { min: 1 });
      const tradeId = optionalString(req.query.tradeId, 'tradeId');
      const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
      const offset = optionalInteger(req.query.offset, 'offset', { min: 0 }) ?? 0;

      const projections = await listLedgerEntryAccountingProjections({
        accountingState,
        accountingPeriodId,
        sweepBatchId,
        tradeId,
        limit,
        offset,
      });

      res.status(200).json(success(projections));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to list entry accounting state');
      res.status(response.statusCode).json(response.body);
    }
  }

  async createAccountingPeriod(
    req: Request<Record<string, never>, Record<string, never>, CreateAccountingPeriodBody>,
    res: Response,
  ): Promise<void> {
    try {
      const body = requireObject<CreateAccountingPeriodBody>(req.body, 'body');
      const period = await createAccountingPeriod({
        periodKey: requireString(body.periodKey, 'periodKey'),
        startsAt: parseObservedAt(body.startsAt, 'startsAt'),
        endsAt: parseObservedAt(body.endsAt, 'endsAt'),
        createdBy: actorFor(req, body.createdBy, 'createdBy'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(201).json(success(period));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to create accounting period');
      res.status(response.statusCode).json(response.body);
    }
  }

  async requestAccountingPeriodClose(
    req: Request<{ periodId: string }, Record<string, never>, UpdateAccountingPeriodStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const periodId = parsePeriodId(req.params.periodId);
      const body = requireObject<UpdateAccountingPeriodStatusBody>(req.body, 'body');
      const period = await updateAccountingPeriodStatus({
        periodId,
        status: 'PENDING_CLOSE',
        actor: actorFor(req, body.actor),
        closeReason: optionalNullableString(body.closeReason, 'closeReason'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(success(period));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to request accounting period close');
      res.status(response.statusCode).json(response.body);
    }
  }

  async closeAccountingPeriod(
    req: Request<{ periodId: string }, Record<string, never>, UpdateAccountingPeriodStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const periodId = parsePeriodId(req.params.periodId);
      const body = requireObject<UpdateAccountingPeriodStatusBody>(req.body, 'body');
      const closePacket = await loadTreasuryAccountingPeriodClosePacket(
        periodId,
        this.reconciliationGate,
      );

      if (!closePacket.ready_for_close) {
        throw new HttpError(
          409,
          'CloseBlocked',
          'Accounting period cannot close while blocking treasury close issues remain',
          {
            blockingIssues: closePacket.blocking_issues,
            reconciliation: closePacket.reconciliation,
          },
        );
      }

      const period = await updateAccountingPeriodStatus({
        periodId,
        status: 'CLOSED',
        actor: actorFor(req, body.actor),
        closeReason: optionalNullableString(body.closeReason, 'closeReason'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(success(period));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to close accounting period');
      res.status(response.statusCode).json(response.body);
    }
  }

  async listSweepBatches(req: Request, res: Response): Promise<void> {
    try {
      const accountingPeriodId =
        req.query.accountingPeriodId === undefined
          ? undefined
          : requireInteger(req.query.accountingPeriodId, 'accountingPeriodId', { min: 1 });
      const status = optionalEnum(req.query.status, SWEEP_BATCH_STATUSES, 'status');
      const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
      const offset = optionalInteger(req.query.offset, 'offset', { min: 0 }) ?? 0;

      const batches = await listSweepBatches({ accountingPeriodId, status, limit, offset });
      res.status(200).json(success(batches));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to list sweep batches');
      res.status(response.statusCode).json(response.body);
    }
  }

  async createSweepBatch(
    req: Request<Record<string, never>, Record<string, never>, CreateSweepBatchBody>,
    res: Response,
  ): Promise<void> {
    try {
      const body = requireObject<CreateSweepBatchBody>(req.body, 'body');
      const batch = await createSweepBatch({
        batchKey: requireString(body.batchKey, 'batchKey'),
        accountingPeriodId: requireInteger(body.accountingPeriodId, 'accountingPeriodId', {
          min: 1,
        }),
        assetSymbol: requireString(body.assetSymbol, 'assetSymbol'),
        expectedTotalRaw: requireString(body.expectedTotalRaw, 'expectedTotalRaw'),
        payoutReceiverAddress: optionalNullableString(
          body.payoutReceiverAddress,
          'payoutReceiverAddress',
        ),
        createdBy: actorFor(req, body.createdBy, 'createdBy'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(201).json(success(batch));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to create sweep batch');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getSweepBatch(req: Request<{ batchId: string }>, res: Response): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const detail = await getSweepBatchDetail(batchId);
      if (!detail) {
        res.status(404).json(failure('NotFound', 'Sweep batch not found'));
        return;
      }

      res.status(200).json(success(detail));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to read sweep batch');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getSweepBatchTrace(req: Request<{ batchId: string }>, res: Response): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const trace = await loadTreasuryBatchTraceReport(batchId);
      res.status(200).json(success(trace));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to build sweep batch trace');
      res.status(response.statusCode).json(response.body);
    }
  }

  async addSweepBatchEntry(
    req: Request<{ batchId: string }, Record<string, never>, AddSweepBatchEntryBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<AddSweepBatchEntryBody>(req.body, 'body');
      const ledgerEntryId = requireInteger(body.ledgerEntryId, 'ledgerEntryId', { min: 1 });
      await this.sweepGate.assertEntries([ledgerEntryId], 'PAYOUT');
      const result = await addSweepBatchEntry({
        sweepBatchId: batchId,
        ledgerEntryId,
        allocatedBy: actorFor(req, body.allocatedBy, 'allocatedBy'),
        entryAmountRaw: optionalString(body.entryAmountRaw, 'entryAmountRaw'),
      });

      res.status(201).json(success(result));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to allocate sweep batch entry');
      res.status(response.statusCode).json(response.body);
    }
  }

  async requestSweepBatchApproval(
    req: Request<{ batchId: string }, Record<string, never>, UpdateSweepBatchStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<UpdateSweepBatchStatusBody>(req.body, 'body');
      const detail = await getSweepBatchDetail(batchId);
      if (!detail) {
        throw new HttpError(404, 'NotFound', 'Sweep batch not found');
      }
      if (detail.entries.length === 0) {
        throw new HttpError(409, 'ApprovalBlocked', 'Sweep batch has no allocated entries');
      }
      if (!detail.batch.payout_receiver_address) {
        throw new HttpError(
          409,
          'ApprovalBlocked',
          'Sweep batch requires a recorded payout receiver before approval can begin',
        );
      }
      if (detail.totals.allocatedAmountRaw !== detail.batch.expected_total_raw) {
        throw new HttpError(
          409,
          'ApprovalBlocked',
          'Sweep batch total does not match allocated entry total',
          {
            expectedTotalRaw: detail.batch.expected_total_raw,
            allocatedAmountRaw: detail.totals.allocatedAmountRaw,
          },
        );
      }
      await this.sweepGate.assertBatch(detail, 'PAYOUT');

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'PENDING_APPROVAL',
        actor: actorFor(req, body.actor),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(success(batch));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to request sweep batch approval');
      res.status(response.statusCode).json(response.body);
    }
  }

  async approveSweepBatch(
    req: Request<{ batchId: string }, Record<string, never>, UpdateSweepBatchStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<UpdateSweepBatchStatusBody>(req.body, 'body');
      const detail = await getSweepBatchDetail(batchId);
      if (!detail) {
        throw new HttpError(404, 'NotFound', 'Sweep batch not found');
      }
      if (detail.totals.allocatedAmountRaw !== detail.batch.expected_total_raw) {
        throw new HttpError(
          409,
          'ApprovalBlocked',
          'Sweep batch total does not match allocated entry total',
        );
      }
      await this.sweepGate.assertBatch(detail, 'PAYOUT');

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'APPROVED',
        actor: actorFor(req, body.actor),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(success(batch));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to approve sweep batch');
      res.status(response.statusCode).json(response.body);
    }
  }

  async markSweepBatchExecuted(
    req: Request<{ batchId: string }, Record<string, never>, UpdateSweepBatchStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<UpdateSweepBatchStatusBody>(req.body, 'body');
      const matchedSweepTxHash = optionalNullableString(
        body.matchedSweepTxHash,
        'matchedSweepTxHash',
      );
      if (!matchedSweepTxHash) {
        throw new HttpError(
          400,
          'ValidationError',
          'matchedSweepTxHash is required for executed sweep batches',
        );
      }

      let batch;
      try {
        batch = await this.sweepExecutionMatcher.matchApprovedBatch({
          batchId,
          txHash: matchedSweepTxHash,
          actor: actorFor(req, body.actor),
          metadata: optionalRecord(body.metadata, 'metadata'),
        });
      } catch (error) {
        if (error instanceof Error) {
          throw new HttpError(409, 'ExecutionMatchFailed', error.message);
        }
        throw error;
      }

      res.status(200).json(success(batch));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to mark sweep batch executed');
      res.status(response.statusCode).json(response.body);
    }
  }

  async recordPartnerHandoff(
    req: Request<{ batchId: string }, Record<string, never>, UpsertPartnerHandoffBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<UpsertPartnerHandoffBody>(req.body, 'body');
      const handoffStatus = requireString(body.handoffStatus, 'handoffStatus');
      if (!isProviderHandoffStatus(handoffStatus)) {
        throw new HttpError(400, 'ValidationError', 'handoffStatus must be valid');
      }

      const handoff = await upsertPartnerHandoff({
        sweepBatchId: batchId,
        partnerName: requireString(body.partnerName, 'partnerName'),
        partnerReference: requireString(body.partnerReference, 'partnerReference'),
        handoffStatus,
        evidenceReference: optionalNullableString(body.evidenceReference, 'evidenceReference'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      // The partner is what the handoff asserts, not who performed it. The
      // chain records the authenticated principal that recorded the handoff and
      // keeps the partner assertion beside it as evidence.
      //
      // WP-4 B-09 / FAIL-11. The batch used to advance to HANDED_OFF on the
      // strength of being EXECUTED alone, whatever the provider had reported --
      // so recording a CREATED or FAILED handoff marked the batch handed off
      // and opened realization behind it. The provider state now has to mean
      // the instruction actually left.
      const detail = await getSweepBatchDetail(batchId);
      if (detail?.batch.status === 'EXECUTED' && isHandedOff(handoffStatus)) {
        await updateSweepBatchStatus({
          batchId,
          status: 'HANDED_OFF',
          actor: actorFor(req, body.actor),
          metadata: {
            partnerName: handoff.partner_name,
            partnerReference: handoff.partner_reference,
          },
        });
      }

      res.status(200).json(success(handoff));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to record external handoff');
      res.status(response.statusCode).json(response.body);
    }
  }

  async closeSweepBatch(
    req: Request<{ batchId: string }, Record<string, never>, UpdateSweepBatchStatusBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<UpdateSweepBatchStatusBody>(req.body, 'body');
      const detail = await getSweepBatchDetail(batchId);
      if (!detail) {
        throw new HttpError(404, 'NotFound', 'Sweep batch not found');
      }

      if (!detail.partnerHandoff || detail.partnerHandoff.handoff_status !== 'COMPLETED') {
        throw new HttpError(
          409,
          'CloseBlocked',
          'Sweep batch cannot close without completed external handoff evidence',
        );
      }

      const unresolved = detail.entries.filter(
        (entry) => !['REALIZED'].includes(entry.accounting_state),
      );
      if (unresolved.length > 0) {
        throw new HttpError(
          409,
          'CloseBlocked',
          'Sweep batch cannot close while entries remain unrealized or in exception',
          {
            entryIds: unresolved.map((entry) => entry.ledger_entry_id),
            states: unresolved.map((entry) => entry.accounting_state),
          },
        );
      }
      await this.sweepGate.assertBatch(detail, 'CANONICAL');

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'CLOSED',
        actor: actorFor(req, body.actor),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(success(batch));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to close sweep batch');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getEntryAccounting(req: Request<{ entryId: string }>, res: Response): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const projection = await getLedgerEntryAccountingProjection(entryId);
      if (!projection) {
        res.status(404).json(failure('NotFound', 'Ledger entry accounting projection not found'));
        return;
      }

      res.status(200).json(success(projection));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to read entry accounting state');
      res.status(response.statusCode).json(response.body);
    }
  }

  async createEntryRealization(
    req: Request<{ entryId: string }, Record<string, never>, CreateRevenueRealizationBody>,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const body = requireObject<CreateRevenueRealizationBody>(req.body, 'body');
      const realization = await createRevenueRealization({
        reconciliationBinding: await resolveRealizationBinding(this.reconciliationGate, entryId),
        ledgerEntryId: entryId,
        accountingPeriodId: requireInteger(body.accountingPeriodId, 'accountingPeriodId', {
          min: 1,
        }),
        sweepBatchId:
          body.sweepBatchId === undefined || body.sweepBatchId === null
            ? null
            : requireInteger(body.sweepBatchId, 'sweepBatchId', { min: 1 }),
        partnerHandoffId:
          body.partnerHandoffId === undefined || body.partnerHandoffId === null
            ? null
            : requireInteger(body.partnerHandoffId, 'partnerHandoffId', { min: 1 }),
        actor: actorFor(req, body.actor),
        note: optionalNullableString(body.note, 'note'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(201).json(success(realization));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to create revenue realization');
      res.status(response.statusCode).json(response.body);
    }
  }

  async getTreasuryPartnerHandoff(req: Request<{ entryId: string }>, res: Response): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const handoff = await getTreasuryPartnerHandoffByLedgerEntryId(entryId);
      if (!handoff) {
        res.status(404).json(failure('NotFound', 'Treasury partner handoff not found'));
        return;
      }

      const events = await listTreasuryPartnerHandoffEventsByLedgerEntryId(entryId);
      res.status(200).json(
        success({
          handoff,
          events,
        }),
      );
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to read treasury partner handoff');
      res.status(response.statusCode).json(response.body);
    }
  }

  async upsertTreasuryPartnerHandoff(
    req: Request<{ entryId: string }, Record<string, never>, UpsertTreasuryPartnerHandoffBody>,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const body = requireObject<UpsertTreasuryPartnerHandoffBody>(req.body, 'body');
      const partnerCode = requireString(body.partnerCode, 'partnerCode');
      const partnerStatus = requireString(body.partnerStatus, 'partnerStatus');
      assertTreasuryPartnerCode(partnerCode);
      assertTreasuryPartnerHandoffStatus(partnerStatus);

      const result = await upsertTreasuryPartnerHandoff({
        ledgerEntryId: entryId,
        partnerCode,
        handoffReference: requireString(body.handoffReference, 'handoffReference'),
        partnerStatus,
        payoutReference: optionalNullableString(body.payoutReference, 'payoutReference'),
        transferReference: optionalNullableString(body.transferReference, 'transferReference'),
        drainReference: optionalNullableString(body.drainReference, 'drainReference'),
        destinationExternalAccountId: optionalNullableString(
          body.destinationExternalAccountId,
          'destinationExternalAccountId',
        ),
        liquidationAddressId: optionalNullableString(
          body.liquidationAddressId,
          'liquidationAddressId',
        ),
        sourceAmount: optionalNullableString(body.sourceAmount, 'sourceAmount'),
        sourceCurrency: optionalNullableString(body.sourceCurrency, 'sourceCurrency'),
        destinationAmount: optionalNullableString(body.destinationAmount, 'destinationAmount'),
        destinationCurrency: optionalNullableString(
          body.destinationCurrency,
          'destinationCurrency',
        ),
        actor: actorFor(req, body.actor),
        note: optionalNullableString(body.note, 'note'),
        failureCode: optionalNullableString(body.failureCode, 'failureCode'),
        initiatedAt: parseObservedAt(body.initiatedAt, 'initiatedAt'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(
        success({
          handoff: result.handoff,
          created: result.created,
          idempotentReplay: result.idempotentReplay,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof BankPayoutConflictError ||
        error instanceof TreasuryPartnerHandoffConflictError
      ) {
        res.status(409).json(buildFailure(409, 'Conflict', error.message, { code: error.code }));
        return;
      }

      const response = mapValidationError(error, 'Failed to persist treasury partner handoff');
      res.status(response.statusCode).json(response.body);
    }
  }

  async appendTreasuryPartnerHandoffEvidence(
    req: Request<
      { entryId: string },
      Record<string, never>,
      AppendTreasuryPartnerHandoffEvidenceBody
    >,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const body = requireObject<AppendTreasuryPartnerHandoffEvidenceBody>(req.body, 'body');
      const partnerCode = requireString(body.partnerCode, 'partnerCode');
      const partnerStatus = requireString(body.partnerStatus, 'partnerStatus');
      assertTreasuryPartnerCode(partnerCode);
      assertTreasuryPartnerHandoffStatus(partnerStatus);

      const bankState = optionalString(body.bankState, 'bankState');
      if (bankState !== undefined && bankState !== null) {
        assertBankPayoutState(bankState);
      }

      const result = await appendTreasuryPartnerHandoffEvidence({
        ledgerEntryId: entryId,
        partnerCode,
        providerEventId: requireString(body.providerEventId, 'providerEventId'),
        eventType: requireString(body.eventType, 'eventType'),
        partnerStatus,
        payoutReference: optionalNullableString(body.payoutReference, 'payoutReference'),
        transferReference: optionalNullableString(body.transferReference, 'transferReference'),
        drainReference: optionalNullableString(body.drainReference, 'drainReference'),
        destinationExternalAccountId: optionalNullableString(
          body.destinationExternalAccountId,
          'destinationExternalAccountId',
        ),
        liquidationAddressId: optionalNullableString(
          body.liquidationAddressId,
          'liquidationAddressId',
        ),
        bankReference: optionalNullableString(body.bankReference, 'bankReference'),
        bankState: bankState ?? null,
        evidenceReference: optionalNullableString(body.evidenceReference, 'evidenceReference'),
        failureCode: optionalNullableString(body.failureCode, 'failureCode'),
        observedAt: parseObservedAt(body.observedAt, 'observedAt'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(
        success({
          handoff: result.handoff,
          event: result.event,
          created: result.created,
          idempotentReplay: result.idempotentReplay,
          // The caller is told whether its callback became the authoritative
          // state. A recorded-but-not-applied event is a successful delivery of
          // evidence that did not move anything, and a provider that cannot
          // tell the two apart will retry a state it already lost.
          transition: result.transition,
          applied: result.applied,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof BankPayoutConflictError ||
        error instanceof TreasuryPartnerHandoffConflictError
      ) {
        res.status(409).json(buildFailure(409, 'Conflict', error.message, { code: error.code }));
        return;
      }

      const response = mapValidationError(
        error,
        'Failed to persist treasury partner handoff evidence',
      );
      res.status(response.statusCode).json(response.body);
    }
  }

  async appendState(
    req: Request<{ entryId: string }, Record<string, never>, AppendStateBody>,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const body = requireObject<AppendStateBody>(req.body, 'body');
      const requestedState = requireString(body.state, 'state');
      const note = optionalString(body.note, 'note');
      const actor = optionalActorFor(req, body.actor);
      assertPayoutState(requestedState);

      const entry = await getLedgerEntryById(entryId);
      if (!entry) {
        res.status(404).json(failure('NotFound', 'Ledger entry not found'));
        return;
      }

      const latest = await getLatestPayoutState(entryId);
      const currentState = latest?.state || 'PENDING_REVIEW';
      assertValidTransition(currentState, requestedState);

      if (requestedState === 'EXTERNAL_EXECUTION_CONFIRMED') {
        throw new HttpError(
          409,
          'EvidenceRequired',
          'External execution completion must be recorded through confirmed payout evidence, not manual state updates.',
        );
      }

      if (requestedState === 'READY_FOR_EXTERNAL_HANDOFF') {
        const entries = await getLedgerEntries({ tradeId: entry.trade_id, limit: 500, offset: 0 });
        const candidate = entries.find((item) => item.id === entryId);
        if (!candidate) {
          throw new HttpError(
            404,
            'NotFound',
            'Ledger entry not found in payout eligibility scope',
          );
        }

        const eligibility = await this.eligibility.assessEntries([candidate]);
        const gate = eligibility.get(entryId);
        if (!gate?.eligibleForPayout) {
          throw new HttpError(
            409,
            'EligibilityBlocked',
            `Ledger entry is not eligible for payout: ${gate?.blockedReasons.join('; ') || 'unknown gate failure'}`,
          );
        }
      }

      const event = await appendPayoutState({
        ledgerEntryId: entryId,
        state: requestedState,
        note,
        actor,
      });
      res.status(200).json(success(event));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to append payout state');
      res.status(response.statusCode).json(response.body);
    }
  }

  async upsertDeposit(
    req: Request<Record<string, never>, Record<string, never>, UpsertDepositBody>,
    res: Response,
  ): Promise<void> {
    try {
      const body = requireObject<UpsertDepositBody>(req.body, 'body');
      const depositState = requireString(body.depositState, 'depositState');
      assertFiatDepositState(depositState);

      const result = await upsertFiatDepositReference({
        rampReference: requireString(body.rampReference, 'rampReference'),
        tradeId: requireString(body.tradeId, 'tradeId'),
        ledgerEntryId:
          body.ledgerEntryId === undefined || body.ledgerEntryId === null
            ? null
            : requireInteger(body.ledgerEntryId, 'ledgerEntryId', { min: 1 }),
        depositState,
        sourceAmount: requireString(body.sourceAmount, 'sourceAmount'),
        currency: requireString(body.currency, 'currency'),
        expectedAmount: requireString(body.expectedAmount, 'expectedAmount'),
        expectedCurrency: requireString(body.expectedCurrency, 'expectedCurrency'),
        observedAt: parseObservedAt(body.observedAt, 'observedAt'),
        providerEventId: requireString(body.providerEventId, 'providerEventId'),
        providerAccountRef: requireString(body.providerAccountRef, 'providerAccountRef'),
        failureCode: optionalNullableString(body.failureCode, 'failureCode'),
        reversalReference: optionalNullableString(body.reversalReference, 'reversalReference'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(200).json(
        success({
          reference: result.reference,
          eventCreated: result.eventCreated,
          idempotentReplay: result.idempotentReplay,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof FiatDepositConflictError) {
        res.status(409).json(buildFailure(409, 'Conflict', error.message, { code: error.code }));
        return;
      }

      const response = mapValidationError(error, 'Failed to persist fiat deposit reference');
      res.status(response.statusCode).json(response.body);
    }
  }

  async upsertBankConfirmation(
    req: Request<{ entryId: string }, Record<string, never>, UpsertBankConfirmationBody>,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = parseEntryId(req.params.entryId);
      const body = requireObject<UpsertBankConfirmationBody>(req.body, 'body');
      const bankState = requireString(body.bankState, 'bankState');
      assertBankPayoutState(bankState);

      const result = await upsertBankPayoutConfirmation({
        ledgerEntryId: entryId,
        payoutReference: optionalNullableString(body.payoutReference, 'payoutReference'),
        bankReference: requireString(body.bankReference, 'bankReference'),
        bankState,
        confirmedAt: parseObservedAt(body.confirmedAt, 'confirmedAt'),
        source: requireString(body.source, 'source'),
        actor: actorFor(req, body.actor),
        failureCode: optionalNullableString(body.failureCode, 'failureCode'),
        evidenceReference: optionalNullableString(body.evidenceReference, 'evidenceReference'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      let completionEvent = null;
      if (result.confirmation.bank_state === 'CONFIRMED') {
        const latest = await getLatestPayoutState(entryId);
        if (latest?.state === 'AWAITING_EXTERNAL_CONFIRMATION') {
          completionEvent = await appendPayoutState({
            ledgerEntryId: entryId,
            state: 'EXTERNAL_EXECUTION_CONFIRMED',
            note: 'Auto-completed from confirmed external execution evidence recorded through bank confirmation.',
            actor: result.confirmation.actor,
          });
        }
      }

      res.status(200).json(
        success({
          confirmation: result.confirmation,
          created: result.created,
          idempotentReplay: result.idempotentReplay,
          completionEvent,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof BankPayoutConflictError) {
        res.status(409).json(buildFailure(409, 'Conflict', error.message, { code: error.code }));
        return;
      }

      const response = mapValidationError(error, 'Failed to persist bank payout confirmation');
      res.status(response.statusCode).json(response.body);
    }
  }

  async exportEntries(req: Request, res: Response): Promise<void> {
    try {
      const format = optionalEnum(req.query.format, EXPORT_FORMATS, 'format') ?? 'json';
      const request = parseExportRequest(req.query);
      const page = await loadLedgerExportPage(request, async (entries) => {
        const eligibility = await this.eligibility.assessEntries(entries);
        return entries.map((entry) => ({
          ...entry,
          ...(eligibility.has(entry.id)
            ? serializeEligibility(eligibility.get(entry.id)!)
            : fallbackEligibility()),
        }));
      });

      assertCompleteExportDelivery(page, format, request.allowPartial);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="treasury-ledger.csv"');
        res.setHeader('X-Treasury-Export-Cutoff', page.cutoff);
        res.setHeader('X-Treasury-Export-Row-Count', String(page.exportedRowCount));
        res.setHeader('X-Treasury-Export-Amount-Raw', page.exportedAmountRaw);
        res.status(200).send(toCsv(page.entries));
        return;
      }

      // The envelope carries the cutoff, snapshot totals and continuation the
      // consumer needs to prove it received every row exactly once. That is the
      // point of H-32, so `data` is an export document rather than a bare array.
      res.status(200).json(success(page));
    } catch (error: unknown) {
      if (error instanceof ExportRequestError) {
        res
          .status(error.code === 'IncompleteExport' ? 409 : 400)
          .json(failure(error.code, error.message));
        return;
      }

      if (error instanceof HttpError) {
        res.status(error.statusCode).json(failure(error.code, error.message, error.details));
        return;
      }

      res
        .status(500)
        .json(
          failure(
            'InternalError',
            error instanceof Error ? error.message : 'Failed to export entries',
          ),
        );
    }
  }
}
