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
import { TreasuryIngestionService } from '../core/ingestion';
import { ReconciliationGateService } from '../core/reconciliationGate';
import { SweepExecutionMatcherService } from '../core/sweepExecutionMatcher';
import { assertFiatDepositState, FiatDepositConflictError } from '../core/fiatDeposit';
import { assertValidTransition } from '../core/payout';
import {
  appendPayoutState,
  addSweepBatchEntry,
  createAccountingPeriod,
  createRevenueRealization,
  createSweepBatch,
  listLedgerEntryAccountingProjections,
  getLedgerEntryAccountingProjection,
  getLatestPayoutState,
  getLedgerEntries,
  getLedgerEntryById,
  getSweepBatchDetail,
  listDistinctLedgerTradeIds,
  listAccountingPeriods,
  listSweepBatches,
  updateAccountingPeriodStatus,
  updateSweepBatchStatus,
  upsertPartnerHandoff,
  upsertBankPayoutConfirmation,
  upsertFiatDepositReference,
} from '../database/queries';
import {
  AccountingPeriodStatus,
  BankPayoutState,
  FiatDepositState,
  PartnerHandoffStatus,
  PayoutState,
  SweepBatchStatus,
  TreasuryAccountingState,
} from '../types';

const PAYOUT_STATES: PayoutState[] = [
  'PENDING_REVIEW',
  'READY_FOR_EXTERNAL_HANDOFF',
  'AWAITING_EXTERNAL_CONFIRMATION',
  'EXTERNAL_EXECUTION_CONFIRMED',
  'CANCELLED',
];

const EXPORT_FORMATS = ['json', 'csv'] as const;
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
const PARTNER_HANDOFF_STATUSES: PartnerHandoffStatus[] = [
  'CREATED',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'COMPLETED',
  'FAILED',
];
const ACCOUNTING_STATES: TreasuryAccountingState[] = [
  'HELD',
  'ALLOCATED_TO_SWEEP',
  'SWEPT',
  'HANDED_OFF',
  'REALIZED',
  'EXCEPTION',
];

type AppendStateBody = {
  state?: string;
  note?: string;
  actor?: string;
};

type UpsertDepositBody = {
  rampReference?: string;
  tradeId?: string;
  ledgerEntryId?: number | null;
  depositState?: FiatDepositState;
  sourceAmount?: string;
  currency?: string;
  expectedAmount?: string;
  expectedCurrency?: string;
  observedAt?: string;
  providerEventId?: string;
  providerAccountRef?: string;
  failureCode?: string | null;
  reversalReference?: string | null;
  metadata?: Record<string, unknown>;
};

type UpsertBankConfirmationBody = {
  payoutReference?: string | null;
  bankReference?: string;
  bankState?: BankPayoutState;
  confirmedAt?: string;
  source?: string;
  actor?: string;
  failureCode?: string | null;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
};

type CreateAccountingPeriodBody = {
  periodKey?: string;
  startsAt?: string;
  endsAt?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
};

type UpdateAccountingPeriodStatusBody = {
  actor?: string;
  closeReason?: string | null;
  metadata?: Record<string, unknown>;
};

type CreateSweepBatchBody = {
  batchKey?: string;
  accountingPeriodId?: number;
  assetSymbol?: string;
  expectedTotalRaw?: string;
  payoutReceiverAddress?: string | null;
  createdBy?: string;
  metadata?: Record<string, unknown>;
};

type AddSweepBatchEntryBody = {
  ledgerEntryId?: number;
  allocatedBy?: string;
  entryAmountRaw?: string;
};

type UpdateSweepBatchStatusBody = {
  actor?: string;
  matchedSweepTxHash?: string | null;
  metadata?: Record<string, unknown>;
};

type UpsertPartnerHandoffBody = {
  partnerName?: string;
  partnerReference?: string;
  handoffStatus?: PartnerHandoffStatus;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
};

type CreateRevenueRealizationBody = {
  accountingPeriodId?: number;
  sweepBatchId?: number | null;
  partnerHandoffId?: number | null;
  actor?: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

type EligibilitySummary = {
  confirmationStage: string | null;
  latestBlockNumber: number | null;
  safeBlockNumber: number | null;
  finalizedBlockNumber: number | null;
  reconciliationStatus: string;
  reconciliationRunKey: string | null;
  reconciliationFreshness: 'FRESH' | 'STALE' | 'MISSING';
  reconciliationCompletedAt: string | null;
  staleRunningRunCount: number;
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
    eligibleForPayout: eligibility.eligibleForPayout,
    eligibleForExport: eligibility.eligibleForExport,
    blockedReasons: eligibility.blockedReasons,
  };
}

function serializeReconciliationControlSummary(summary: {
  status: 'CLEAR' | 'BLOCKED' | 'STALE' | 'MISSING' | 'UNKNOWN';
  freshness: 'FRESH' | 'STALE' | 'MISSING';
  latestCompletedRunKey: string | null;
  latestCompletedRunAt: Date | null;
  latestCompletedRunAgeSeconds: number | null;
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

function mapValidationError(error: unknown, fallbackMessage: string) {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      body: failure(error.code, error.message, error.details),
    };
  }

  if (error instanceof Error) {
    return {
      statusCode: 400,
      body: failure('ValidationError', error.message || fallbackMessage),
    };
  }

  return {
    statusCode: 400,
    body: failure('ValidationError', fallbackMessage),
  };
}

function assertPayoutState(value: string): asserts value is PayoutState {
  if (!PAYOUT_STATES.includes(value as PayoutState)) {
    throw new HttpError(400, 'ValidationError', 'state must be a valid payout state');
  }
}

function toCsv(
  entries: Array<Awaited<ReturnType<typeof getLedgerEntries>>[number] & EligibilitySummary>,
): string {
  const headers = [
    'id',
    'trade_id',
    'tx_hash',
    'block_number',
    'event_name',
    'component_type',
    'amount_raw',
    'latest_state',
    'confirmation_stage',
    'reconciliation_status',
    'reconciliation_freshness',
    'reconciliation_completed_at',
    'stale_running_run_count',
    'eligible_for_export',
    'blocked_reasons',
    'latest_state_at',
    'created_at',
  ];

  const rows = entries.map((entry) => [
    entry.id,
    entry.trade_id,
    entry.tx_hash,
    entry.block_number,
    entry.event_name,
    entry.component_type,
    entry.amount_raw,
    entry.latest_state,
    entry.confirmationStage ?? '',
    entry.reconciliationStatus,
    entry.reconciliationFreshness,
    entry.reconciliationCompletedAt ?? '',
    entry.staleRunningRunCount,
    entry.eligibleForExport ? 'true' : 'false',
    entry.blockedReasons.join('|'),
    entry.latest_state_at.toISOString(),
    entry.created_at.toISOString(),
  ]);

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

export class TreasuryController {
  private readonly ingestion = new TreasuryIngestionService();
  private readonly eligibility = new TreasuryEligibilityService();
  private readonly reconciliationGate = new ReconciliationGateService();
  private readonly sweepExecutionMatcher = new SweepExecutionMatcherService();

  async ingest(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.ingestion.ingestOnce();
      res.status(200).json(success(result));
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
        createdBy: requireString(body.createdBy, 'createdBy'),
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
        actor: requireString(body.actor, 'actor'),
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
      const batches = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const page = await listSweepBatches({
          accountingPeriodId: periodId,
          limit: pageSize,
          offset,
        });
        batches.push(...page);
        if (page.length < pageSize) {
          break;
        }
      }
      const openBatches = batches.filter((batch) => !['CLOSED', 'VOID'].includes(batch.status));
      if (openBatches.length > 0) {
        throw new HttpError(
          409,
          'CloseBlocked',
          'Accounting period cannot close while sweep batches remain open',
          {
            openBatchIds: openBatches.map((batch) => batch.id),
          },
        );
      }

      const detailEntries = await Promise.all(
        batches.map(async (batch) => {
          const detail = await getSweepBatchDetail(batch.id);
          return detail?.entries ?? [];
        }),
      );
      const tradeIds = Array.from(
        new Set(detailEntries.flatMap((entries) => entries.map((entry) => entry.trade_id))),
      );
      if (tradeIds.length > 0) {
        const summary = await this.reconciliationGate.summarizeTrades(tradeIds);
        if (summary.status !== 'CLEAR') {
          throw new HttpError(
            409,
            'CloseBlocked',
            'Accounting period cannot close while reconciliation is not clear for batch trades',
            {
              reconciliationStatus: summary.status,
              blockedReasons: summary.blockedReasons,
              tradeIds,
            },
          );
        }
      }

      const period = await updateAccountingPeriodStatus({
        periodId,
        status: 'CLOSED',
        actor: requireString(body.actor, 'actor'),
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
        createdBy: requireString(body.createdBy, 'createdBy'),
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

  async addSweepBatchEntry(
    req: Request<{ batchId: string }, Record<string, never>, AddSweepBatchEntryBody>,
    res: Response,
  ): Promise<void> {
    try {
      const batchId = parseBatchId(req.params.batchId);
      const body = requireObject<AddSweepBatchEntryBody>(req.body, 'body');
      const result = await addSweepBatchEntry({
        sweepBatchId: batchId,
        ledgerEntryId: requireInteger(body.ledgerEntryId, 'ledgerEntryId', { min: 1 }),
        allocatedBy: requireString(body.allocatedBy, 'allocatedBy'),
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

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'PENDING_APPROVAL',
        actor: requireString(body.actor, 'actor'),
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

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'APPROVED',
        actor: requireString(body.actor, 'actor'),
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
          actor: requireString(body.actor, 'actor'),
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
      if (!PARTNER_HANDOFF_STATUSES.includes(handoffStatus as PartnerHandoffStatus)) {
        throw new HttpError(400, 'ValidationError', 'handoffStatus must be valid');
      }

      const handoff = await upsertPartnerHandoff({
        sweepBatchId: batchId,
        partnerName: requireString(body.partnerName, 'partnerName'),
        partnerReference: requireString(body.partnerReference, 'partnerReference'),
        handoffStatus: handoffStatus as PartnerHandoffStatus,
        evidenceReference: optionalNullableString(body.evidenceReference, 'evidenceReference'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      const detail = await getSweepBatchDetail(batchId);
      if (detail?.batch.status === 'EXECUTED') {
        await updateSweepBatchStatus({
          batchId,
          status: 'HANDED_OFF',
          actor: `system:external-handoff:${handoff.partner_name}`,
          metadata: { partnerReference: handoff.partner_reference },
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

      const batch = await updateSweepBatchStatus({
        batchId,
        status: 'CLOSED',
        actor: requireString(body.actor, 'actor'),
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
        actor: requireString(body.actor, 'actor'),
        note: optionalNullableString(body.note, 'note'),
        metadata: optionalRecord(body.metadata, 'metadata'),
      });

      res.status(201).json(success(realization));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to create revenue realization');
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
      const actor = optionalString(body.actor, 'actor');
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
        actor: requireString(body.actor, 'actor'),
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
      const entries = await getLedgerEntries({ limit: 5000, offset: 0 });
      const eligibility = await this.eligibility.assessEntries(entries);
      const exportableEntries = entries
        .map((entry) => ({
          ...entry,
          ...(eligibility.has(entry.id)
            ? serializeEligibility(eligibility.get(entry.id)!)
            : fallbackEligibility()),
        }))
        .filter((entry) => entry.eligibleForExport);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="treasury-ledger.csv"');
        res.status(200).send(toCsv(exportableEntries));
        return;
      }

      res.status(200).json(success(exportableEntries));
    } catch (error: unknown) {
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
