/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { projectLedgerEntryAccountingState } from '../../core/accountingStateProjection';
import type { LedgerEntryAccountingFacts, TreasuryAccountingState } from '../../types';
import { pool } from '../connection';

const ACCOUNTING_STATE_FILTER_CHUNK_MULTIPLIER = 4;
const ACCOUNTING_STATE_FILTER_MIN_CHUNK_SIZE = 50;

type Queryable = Pick<typeof pool, 'query'>;

export async function getLedgerEntryAccountingFacts(
  ledgerEntryId: number,
  queryable: Queryable = pool,
): Promise<LedgerEntryAccountingFacts | null> {
  const result = await queryable.query<LedgerEntryAccountingFacts>(
    `SELECT
        e.id AS ledger_entry_id,
        e.trade_id,
        e.component_type,
        e.amount_raw,
        alloc.entry_amount_raw AS allocated_amount_raw,
        alloc.created_at AS allocated_at,
        e.source_timestamp AS earned_at,
        payout.state AS payout_state,
        period.id AS accounting_period_id,
        period.period_key AS accounting_period_key,
        period.status AS accounting_period_status,
        batch.id AS sweep_batch_id,
        batch.status AS sweep_batch_status,
        alloc.allocation_status,
        claim.tx_hash AS matched_sweep_tx_hash,
        claim.block_number AS matched_sweep_block_number,
        claim.observed_at AS matched_swept_at,
        claim.treasury_identity AS matched_treasury_identity,
        claim.payout_receiver AS matched_payout_receiver,
        claim.amount_raw AS matched_claim_amount_raw,
        handoff.id AS partner_handoff_id,
        handoff.partner_name,
        handoff.partner_reference,
        handoff.handoff_status AS partner_handoff_status,
        handoff.submitted_at AS partner_submitted_at,
        handoff.acknowledged_at AS partner_acknowledged_at,
        handoff.completed_at AS partner_completed_at,
        handoff.failed_at AS partner_failed_at,
        handoff.verified_at AS partner_verified_at,
        deposit.ramp_reference AS latest_fiat_deposit_ramp_reference,
        deposit.deposit_state AS latest_fiat_deposit_state,
        deposit.failure_class AS latest_fiat_deposit_failure_class,
        deposit.observed_at AS latest_fiat_deposit_observed_at,
        bank.bank_reference AS latest_bank_reference,
        bank.bank_state AS latest_bank_payout_state,
        bank.failure_code AS latest_bank_failure_code,
        bank.confirmed_at AS latest_bank_confirmed_at,
        realization.realization_status AS revenue_realization_status,
        realization.realized_at
      FROM treasury_ledger_entries e
      LEFT JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) payout ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM sweep_batch_entries sbe
        WHERE sbe.ledger_entry_id = e.id
          AND sbe.allocation_status = 'ALLOCATED'
        ORDER BY sbe.updated_at DESC, sbe.id DESC
        LIMIT 1
      ) alloc ON TRUE
      LEFT JOIN sweep_batches batch ON batch.id = alloc.sweep_batch_id
      LEFT JOIN accounting_periods period ON period.id = batch.accounting_period_id
      LEFT JOIN treasury_claim_events claim ON claim.matched_sweep_batch_id = batch.id
      LEFT JOIN partner_handoffs handoff ON handoff.sweep_batch_id = batch.id
      LEFT JOIN LATERAL (
        SELECT r.realization_status, r.realized_at
        FROM revenue_realizations r
        WHERE r.ledger_entry_id = e.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) realization ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.ramp_reference, d.deposit_state, d.failure_class, d.observed_at
        FROM fiat_deposit_references d
        WHERE d.ledger_entry_id = e.id
        ORDER BY d.observed_at DESC, d.id DESC
        LIMIT 1
      ) deposit ON TRUE
      LEFT JOIN LATERAL (
        SELECT b.bank_reference, b.bank_state, b.failure_code, b.confirmed_at
        FROM bank_payout_confirmations b
        WHERE b.ledger_entry_id = e.id
        ORDER BY b.confirmed_at DESC, b.id DESC
        LIMIT 1
      ) bank ON TRUE
      WHERE e.id = $1`,
    [ledgerEntryId],
  );

  return result.rows[0] ?? null;
}

export async function listLedgerEntryAccountingProjections(filters?: {
  accountingState?: TreasuryAccountingState;
  accountingPeriodId?: number;
  sweepBatchId?: number;
  tradeId?: string;
  limit?: number;
  offset?: number;
}): Promise<ReturnType<typeof projectLedgerEntryAccountingState>[]> {
  const values: Array<number | string> = [];
  const where: string[] = [];

  if (filters?.accountingPeriodId !== undefined) {
    values.push(filters.accountingPeriodId);
    where.push(`period.id = $${values.length}`);
  }

  if (filters?.sweepBatchId !== undefined) {
    values.push(filters.sweepBatchId);
    where.push(`batch.id = $${values.length}`);
  }

  if (filters?.tradeId !== undefined) {
    values.push(filters.tradeId);
    where.push(`e.trade_id = $${values.length}`);
  }

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const baseQuery = `SELECT
        e.id AS ledger_entry_id,
        e.trade_id,
        e.component_type,
        e.amount_raw,
        alloc.entry_amount_raw AS allocated_amount_raw,
        alloc.created_at AS allocated_at,
        e.source_timestamp AS earned_at,
        payout.state AS payout_state,
        period.id AS accounting_period_id,
        period.period_key AS accounting_period_key,
        period.status AS accounting_period_status,
        batch.id AS sweep_batch_id,
        batch.status AS sweep_batch_status,
        alloc.allocation_status,
        claim.tx_hash AS matched_sweep_tx_hash,
        claim.block_number AS matched_sweep_block_number,
        claim.observed_at AS matched_swept_at,
        claim.treasury_identity AS matched_treasury_identity,
        claim.payout_receiver AS matched_payout_receiver,
        claim.amount_raw AS matched_claim_amount_raw,
        handoff.id AS partner_handoff_id,
        handoff.partner_name,
        handoff.partner_reference,
        handoff.handoff_status AS partner_handoff_status,
        handoff.submitted_at AS partner_submitted_at,
        handoff.acknowledged_at AS partner_acknowledged_at,
        handoff.completed_at AS partner_completed_at,
        handoff.failed_at AS partner_failed_at,
        handoff.verified_at AS partner_verified_at,
        deposit.ramp_reference AS latest_fiat_deposit_ramp_reference,
        deposit.deposit_state AS latest_fiat_deposit_state,
        deposit.failure_class AS latest_fiat_deposit_failure_class,
        deposit.observed_at AS latest_fiat_deposit_observed_at,
        bank.bank_reference AS latest_bank_reference,
        bank.bank_state AS latest_bank_payout_state,
        bank.failure_code AS latest_bank_failure_code,
        bank.confirmed_at AS latest_bank_confirmed_at,
        realization.realization_status AS revenue_realization_status,
        realization.realized_at
      FROM treasury_ledger_entries e
      LEFT JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) payout ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM sweep_batch_entries sbe
        WHERE sbe.ledger_entry_id = e.id
          AND sbe.allocation_status = 'ALLOCATED'
        ORDER BY sbe.updated_at DESC, sbe.id DESC
        LIMIT 1
      ) alloc ON TRUE
      LEFT JOIN sweep_batches batch ON batch.id = alloc.sweep_batch_id
      LEFT JOIN accounting_periods period ON period.id = batch.accounting_period_id
      LEFT JOIN treasury_claim_events claim ON claim.matched_sweep_batch_id = batch.id
      LEFT JOIN partner_handoffs handoff ON handoff.sweep_batch_id = batch.id
      LEFT JOIN LATERAL (
        SELECT r.realization_status, r.realized_at
        FROM revenue_realizations r
        WHERE r.ledger_entry_id = e.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) realization ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.ramp_reference, d.deposit_state, d.failure_class, d.observed_at
        FROM fiat_deposit_references d
        WHERE d.ledger_entry_id = e.id
        ORDER BY d.observed_at DESC, d.id DESC
        LIMIT 1
      ) deposit ON TRUE
      LEFT JOIN LATERAL (
        SELECT b.bank_reference, b.bank_state, b.failure_code, b.confirmed_at
        FROM bank_payout_confirmations b
        WHERE b.ledger_entry_id = e.id
        ORDER BY b.confirmed_at DESC, b.id DESC
        LIMIT 1
      ) bank ON TRUE
      ${whereClause}
      ORDER BY e.source_timestamp DESC, e.id DESC`;

  if (!filters?.accountingState) {
    const unfilteredValues = [...values, limit, offset];
    const limitParam = `$${unfilteredValues.length - 1}`;
    const offsetParam = `$${unfilteredValues.length}`;
    const result = await pool.query<LedgerEntryAccountingFacts>(
      `${baseQuery}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      unfilteredValues,
    );
    return result.rows.map((row: LedgerEntryAccountingFacts) =>
      projectLedgerEntryAccountingState(row),
    );
  }

  const projections: ReturnType<typeof projectLedgerEntryAccountingState>[] = [];
  const chunkSize = Math.max(
    limit * ACCOUNTING_STATE_FILTER_CHUNK_MULTIPLIER,
    ACCOUNTING_STATE_FILTER_MIN_CHUNK_SIZE,
  );
  let rawOffset = 0;
  let filteredOffset = offset;

  while (projections.length < limit) {
    const chunkValues = [...values, chunkSize, rawOffset];
    const limitParam = `$${chunkValues.length - 1}`;
    const offsetParam = `$${chunkValues.length}`;
    const result = await pool.query<LedgerEntryAccountingFacts>(
      `${baseQuery}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      chunkValues,
    );
    if (result.rows.length === 0) {
      break;
    }

    const matchingProjections = result.rows
      .map((row: LedgerEntryAccountingFacts) => projectLedgerEntryAccountingState(row))
      .filter((projection: ReturnType<typeof projectLedgerEntryAccountingState>) => {
        return projection.accounting_state === filters.accountingState;
      });

    for (const projection of matchingProjections) {
      if (filteredOffset > 0) {
        filteredOffset -= 1;
        continue;
      }
      projections.push(projection);
      if (projections.length === limit) {
        break;
      }
    }

    rawOffset += result.rows.length;
    if (result.rows.length < chunkSize) {
      break;
    }
  }

  return projections;
}

export async function getLedgerEntryAccountingProjection(
  ledgerEntryId: number,
  queryable: Queryable = pool,
) {
  const facts = await getLedgerEntryAccountingFacts(ledgerEntryId, queryable);
  return facts ? projectLedgerEntryAccountingState(facts) : null;
}
