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
import { assertFiatDepositState, FiatDepositConflictError } from '../core/fiatDeposit';
import { assertValidTransition } from '../core/payout';
import {
  appendPayoutState,
  getLatestPayoutState,
  getLedgerEntries,
  getLedgerEntryById,
  upsertBankPayoutConfirmation,
  upsertFiatDepositReference,
} from '../database/queries';
import { BankPayoutState, FiatDepositState, PayoutState } from '../types';

const PAYOUT_STATES: PayoutState[] = [
  'PENDING_REVIEW',
  'READY_FOR_PARTNER_SUBMISSION',
  'AWAITING_PARTNER_UPDATE',
  'PARTNER_REPORTED_COMPLETED',
  'CANCELLED',
];

const EXPORT_FORMATS = ['json', 'csv'] as const;

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

type EligibilitySummary = {
  confirmationStage: string | null;
  latestBlockNumber: number | null;
  safeBlockNumber: number | null;
  finalizedBlockNumber: number | null;
  reconciliationStatus: string;
  reconciliationRunKey: string | null;
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
    eligibleForPayout: false,
    eligibleForExport: false,
    blockedReasons: ['Eligibility state unavailable'],
  };
}

function parseEntryId(value: unknown): number {
  return requireInteger(value, 'entryId', { min: 1 });
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
        ...(eligibility.get(entry.id) ?? fallbackEligibility()),
      }));

      res.status(200).json(success(data));
    } catch (error: unknown) {
      const response = mapValidationError(error, 'Failed to list entries');
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

      if (requestedState === 'PARTNER_REPORTED_COMPLETED') {
        throw new HttpError(
          409,
          'EvidenceRequired',
          'Partner-reported completion must be recorded through confirmed payout evidence, not manual state updates.',
        );
      }

      if (requestedState === 'READY_FOR_PARTNER_SUBMISSION') {
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
        if (latest?.state === 'AWAITING_PARTNER_UPDATE') {
          completionEvent = await appendPayoutState({
            ledgerEntryId: entryId,
            state: 'PARTNER_REPORTED_COMPLETED',
            note: 'Auto-completed from confirmed partner payout evidence recorded through bank confirmation.',
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
          ...(eligibility.get(entry.id) ?? fallbackEligibility()),
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
