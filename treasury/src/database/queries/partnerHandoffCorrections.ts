/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { TreasuryPartnerHandoffConflictError } from '../../core/treasuryPartnerHandoff';
import type { TreasuryPartnerHandoff, TreasuryPartnerHandoffStatus } from '../../types';
import { pool } from '../connection';
import {
  listPartnerHandoffConflicts,
  recordPartnerHandoffCorrection,
} from './partnerHandoffConflicts';

/**
 * WP-4 B-09 / FAIL-11: the approved-exception path out of a freeze.
 *
 * A frozen handoff is not repaired by editing it back to the answer someone
 * prefers. The correction is appended beside the conflict it resolves, names
 * the approval that authorised it, and may only settle on one of the two states
 * that were actually claimed -- otherwise the exception would be a third,
 * unevidenced assertion about where the money went.
 */
export async function correctFrozenTreasuryPartnerHandoff(input: {
  ledgerEntryId: number;
  resolvesConflictId: number;
  approvalReference: string;
  resolvedStatus: TreasuryPartnerHandoffStatus;
  actor: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): Promise<TreasuryPartnerHandoff> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const handoffResult = await client.query<TreasuryPartnerHandoff>(
      `SELECT * FROM treasury_partner_handoffs WHERE ledger_entry_id = $1 FOR UPDATE`,
      [input.ledgerEntryId],
    );
    const handoff = handoffResult.rows[0];
    if (!handoff) {
      throw new Error('Treasury partner handoff not found');
    }

    if (!handoff.frozen_at) {
      throw new TreasuryPartnerHandoffConflictError(
        'Treasury partner handoff is not frozen and does not need a correction',
      );
    }

    const conflicts = await listPartnerHandoffConflicts(
      client,
      'LEDGER_ENTRY',
      input.ledgerEntryId,
    );
    const conflict = conflicts.find(
      (record) => record.id === input.resolvesConflictId && record.record_type === 'CONFLICT',
    );
    if (!conflict) {
      throw new TreasuryPartnerHandoffConflictError(
        'Correction must name a recorded conflict for this handoff',
      );
    }

    if (
      input.resolvedStatus !== conflict.retained_status &&
      input.resolvedStatus !== conflict.conflicting_status
    ) {
      throw new TreasuryPartnerHandoffConflictError(
        `Correction must resolve to one of the claimed states (${conflict.retained_status} or ${conflict.conflicting_status})`,
      );
    }

    await recordPartnerHandoffCorrection(client, {
      scope: 'LEDGER_ENTRY',
      subjectId: input.ledgerEntryId,
      partnerCode: handoff.partner_code,
      resolvesConflictId: conflict.id,
      approvalReference: input.approvalReference.trim(),
      retainedStatus: input.resolvedStatus,
      conflictingStatus: conflict.conflicting_status,
      detail: input.detail,
      actor: input.actor.trim(),
      observedAt: new Date(),
      metadata: input.metadata,
    });

    const updated = await client.query<TreasuryPartnerHandoff>(
      `UPDATE treasury_partner_handoffs
       SET partner_status = $2,
           frozen_at = NULL,
           frozen_reason = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [handoff.id, input.resolvedStatus],
    );

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
