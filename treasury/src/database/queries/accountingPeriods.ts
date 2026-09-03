/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { assertAccountingPeriodTransition } from '../../core/accountingPolicy';
import type { AccountingPeriod, AccountingPeriodStatus } from '../../types';
import { pool } from '../connection';

export async function createAccountingPeriod(data: {
  periodKey: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  metadata?: Record<string, unknown>;
}): Promise<AccountingPeriod> {
  const result = await pool.query<AccountingPeriod>(
    `INSERT INTO accounting_periods (
        period_key,
        starts_at,
        ends_at,
        status,
        created_by,
        metadata,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      RETURNING *`,
    [
      data.periodKey,
      data.startsAt,
      data.endsAt,
      'OPEN',
      data.createdBy,
      JSON.stringify(data.metadata ?? {}),
    ],
  );

  return result.rows[0];
}

export async function listAccountingPeriods(params: {
  status?: AccountingPeriodStatus;
  limit: number;
  offset: number;
}): Promise<AccountingPeriod[]> {
  const values: Array<string | number> = [];
  const filters: string[] = [];

  if (params.status) {
    values.push(params.status);
    filters.push(`status = $${values.length}`);
  }

  values.push(params.limit);
  const limitParam = `$${values.length}`;
  values.push(params.offset);
  const offsetParam = `$${values.length}`;
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await pool.query<AccountingPeriod>(
    `SELECT *
     FROM accounting_periods
     ${whereClause}
     ORDER BY starts_at DESC, id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  return result.rows;
}

export async function getAccountingPeriodById(id: number): Promise<AccountingPeriod | null> {
  const result = await pool.query<AccountingPeriod>(
    `SELECT *
     FROM accounting_periods
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

export async function updateAccountingPeriodStatus(data: {
  periodId: number;
  status: AccountingPeriodStatus;
  actor: string;
  closeReason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AccountingPeriod> {
  const existing = await getAccountingPeriodById(data.periodId);
  if (!existing) {
    throw new Error('Accounting period not found');
  }

  assertAccountingPeriodTransition(existing.status, data.status);

  const pendingCloseAt = data.status === 'PENDING_CLOSE' ? new Date() : existing.pending_close_at;
  const closedAt = data.status === 'CLOSED' ? new Date() : existing.closed_at;
  const closedBy = data.status === 'CLOSED' ? data.actor : existing.closed_by;

  const result = await pool.query<AccountingPeriod>(
    `UPDATE accounting_periods
     SET status = $2,
         close_reason = COALESCE($3, close_reason),
         pending_close_at = $4,
         closed_at = $5,
         closed_by = $6,
         metadata = CASE
           WHEN $7::jsonb = '{}'::jsonb THEN metadata
           ELSE metadata || $7::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      data.periodId,
      data.status,
      data.closeReason ?? null,
      pendingCloseAt,
      closedAt,
      closedBy,
      JSON.stringify(data.metadata ?? {}),
    ],
  );

  return result.rows[0];
}
