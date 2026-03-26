import { Request, Response } from 'express';
import { assertBankPayoutState, BankPayoutConflictError } from '../core/bankPayout';
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
  'READY_FOR_PAYOUT',
  'PROCESSING',
  'PAID',
  'CANCELLED',
];

function assertPayoutState(value: string): asserts value is PayoutState {
  if (!PAYOUT_STATES.includes(value as PayoutState)) {
    throw new Error('Invalid payout state');
  }
}

function parseObservedAt(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('observedAt must be a valid ISO timestamp');
  }
  return parsed;
}

function toCsv(entries: Awaited<ReturnType<typeof getLedgerEntries>>): string {
  const headers = [
    'id',
    'trade_id',
    'tx_hash',
    'block_number',
    'event_name',
    'component_type',
    'amount_raw',
    'latest_state',
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
    entry.latest_state_at.toISOString(),
    entry.created_at.toISOString(),
  ]);

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

export class TreasuryController {
  private readonly ingestion = new TreasuryIngestionService();

  async ingest(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.ingestion.ingestOnce();
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Ingestion failed' });
    }
  }

  async listEntries(req: Request, res: Response): Promise<void> {
    try {
      const tradeId = typeof req.query.tradeId === 'string' ? req.query.tradeId : undefined;
      const rawState = typeof req.query.state === 'string' ? req.query.state : undefined;
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
      const offset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

      let state: PayoutState | undefined;
      if (rawState) {
        assertPayoutState(rawState);
        state = rawState;
      }

      const entries = await getLedgerEntries({
        tradeId,
        state,
        limit: Number.isNaN(limit) ? 50 : limit,
        offset: Number.isNaN(offset) ? 0 : offset,
      });

      res.status(200).json({ success: true, data: entries });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error?.message || 'Failed to list entries' });
    }
  }

  async appendState(req: Request<{ entryId: string }, {}, { state: string; note?: string; actor?: string }>, res: Response): Promise<void> {
    try {
      const entryId = Number.parseInt(req.params.entryId, 10);
      if (Number.isNaN(entryId)) {
        res.status(400).json({ success: false, error: 'Invalid entryId' });
        return;
      }

      const entry = await getLedgerEntryById(entryId);
      if (!entry) {
        res.status(404).json({ success: false, error: 'Ledger entry not found' });
        return;
      }

      const requestedState = req.body.state;
      assertPayoutState(requestedState);

      const latest = await getLatestPayoutState(entryId);
      const currentState = latest?.state || 'PENDING_REVIEW';

      assertValidTransition(currentState as PayoutState, requestedState);

      const event = await appendPayoutState({
        ledgerEntryId: entryId,
        state: requestedState,
        note: req.body.note,
        actor: req.body.actor,
      });

      res.status(200).json({ success: true, data: event });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error?.message || 'Failed to append payout state' });
    }
  }

  async upsertDeposit(
    req: Request<
      {},
      {},
      {
        rampReference: string;
        tradeId: string;
        ledgerEntryId?: number | null;
        depositState: FiatDepositState;
        sourceAmount: string;
        currency: string;
        expectedAmount: string;
        expectedCurrency: string;
        observedAt: string;
        providerEventId: string;
        providerAccountRef: string;
        failureCode?: string | null;
        reversalReference?: string | null;
        metadata?: Record<string, unknown>;
      }
    >,
    res: Response,
  ): Promise<void> {
    try {
      assertFiatDepositState(req.body.depositState);

      const result = await upsertFiatDepositReference({
        rampReference: req.body.rampReference,
        tradeId: req.body.tradeId,
        ledgerEntryId:
          typeof req.body.ledgerEntryId === 'number' && Number.isFinite(req.body.ledgerEntryId)
            ? req.body.ledgerEntryId
            : null,
        depositState: req.body.depositState,
        sourceAmount: req.body.sourceAmount,
        currency: req.body.currency,
        expectedAmount: req.body.expectedAmount,
        expectedCurrency: req.body.expectedCurrency,
        observedAt: parseObservedAt(req.body.observedAt),
        providerEventId: req.body.providerEventId,
        providerAccountRef: req.body.providerAccountRef,
        failureCode: req.body.failureCode,
        reversalReference: req.body.reversalReference,
        metadata: req.body.metadata,
      });

      res.status(200).json({
        success: true,
        data: {
          reference: result.reference,
          eventCreated: result.eventCreated,
          idempotentReplay: result.idempotentReplay,
        },
      });
    } catch (error: any) {
      if (error instanceof FiatDepositConflictError) {
        res.status(409).json({ success: false, error: error.message, code: error.code });
        return;
      }

      res.status(400).json({ success: false, error: error?.message || 'Failed to persist fiat deposit reference' });
    }
  }

  async upsertBankConfirmation(
    req: Request<
      { entryId: string },
      {},
      {
        payoutReference?: string | null;
        bankReference: string;
        bankState: BankPayoutState;
        confirmedAt: string;
        source: string;
        actor: string;
        failureCode?: string | null;
        evidenceReference?: string | null;
        metadata?: Record<string, unknown>;
      }
    >,
    res: Response,
  ): Promise<void> {
    try {
      const entryId = Number.parseInt(req.params.entryId, 10);
      if (Number.isNaN(entryId)) {
        res.status(400).json({ success: false, error: 'Invalid entryId' });
        return;
      }

      assertBankPayoutState(req.body.bankState);

      const result = await upsertBankPayoutConfirmation({
        ledgerEntryId: entryId,
        payoutReference: req.body.payoutReference,
        bankReference: req.body.bankReference,
        bankState: req.body.bankState,
        confirmedAt: parseObservedAt(req.body.confirmedAt),
        source: req.body.source,
        actor: req.body.actor,
        failureCode: req.body.failureCode,
        evidenceReference: req.body.evidenceReference,
        metadata: req.body.metadata,
      });

      res.status(200).json({
        success: true,
        data: {
          confirmation: result.confirmation,
          created: result.created,
          idempotentReplay: result.idempotentReplay,
        },
      });
    } catch (error: any) {
      if (error instanceof BankPayoutConflictError) {
        res.status(409).json({ success: false, error: error.message, code: error.code });
        return;
      }

      res.status(400).json({ success: false, error: error?.message || 'Failed to persist bank payout confirmation' });
    }
  }

  async exportEntries(req: Request, res: Response): Promise<void> {
    try {
      const format = typeof req.query.format === 'string' ? req.query.format : 'json';
      const entries = await getLedgerEntries({ limit: 5000, offset: 0 });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="treasury-ledger.csv"');
        res.status(200).send(toCsv(entries));
        return;
      }

      res.status(200).json({ success: true, data: entries });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to export entries' });
    }
  }
}
