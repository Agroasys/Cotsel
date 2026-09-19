/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { assertRealizationAllowed } from '../../core/accountingPolicy';
import {
  assertCompletionEvidence,
  classifyProviderHandoffTransition,
} from '../../core/providerHandoffAuthority';
import { PartnerHandoffConflictError } from '../../core/treasuryPartnerHandoff';
import { rejectConcurrentWrite } from '../../core/transitionConcurrency';
import { recordPartnerHandoffConflict } from './partnerHandoffConflicts';
import type {
  PartnerHandoff,
  PartnerHandoffStatus,
  RevenueRealization,
  SweepBatch,
  TreasuryClaimEvent,
} from '../../types';
import { pool } from '../connection';
import { getLedgerEntryAccountingFacts } from './accountingProjections';

function createExternalPartnerHandoffPayloadHash(input: {
  sweepBatchId: number;
  partnerName: string;
  partnerReference: string;
  handoffStatus: PartnerHandoffStatus;
  evidenceReference: string | null;
  metadata: Record<string, unknown>;
}): string {
  const serialized = JSON.stringify({
    sweepBatchId: input.sweepBatchId,
    partnerName: input.partnerName,
    partnerReference: input.partnerReference,
    handoffStatus: input.handoffStatus,
    evidenceReference: input.evidenceReference,
    metadata: input.metadata,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export async function upsertTreasuryClaimEvent(data: {
  sourceEventId: string;
  matchedSweepBatchId?: number | null;
  txHash: string;
  blockNumber: number;
  observedAt: Date;
  treasuryIdentity: string;
  payoutReceiver: string;
  amountRaw: string;
  triggeredBy?: string | null;
}): Promise<TreasuryClaimEvent> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingByTx = await client.query<TreasuryClaimEvent>(
      `SELECT *
       FROM treasury_claim_events
       WHERE tx_hash = $1
          OR source_event_id = $2`,
      [data.txHash, data.sourceEventId],
    );

    const existing = existingByTx.rows[0];
    if (
      existing &&
      existing.matched_sweep_batch_id !== null &&
      data.matchedSweepBatchId !== undefined &&
      data.matchedSweepBatchId !== null &&
      existing.matched_sweep_batch_id !== data.matchedSweepBatchId
    ) {
      throw new Error('Treasury claim event is already matched to a different sweep batch');
    }

    const result = existing
      ? await client.query<TreasuryClaimEvent>(
          `UPDATE treasury_claim_events
           SET source_event_id = $2,
               matched_sweep_batch_id = COALESCE($3, matched_sweep_batch_id),
               tx_hash = $4,
               block_number = $5,
               observed_at = $6,
               treasury_identity = $7,
               payout_receiver = $8,
               amount_raw = $9,
               triggered_by = $10
           WHERE id = $1
           RETURNING *`,
          [
            existing.id,
            data.sourceEventId,
            data.matchedSweepBatchId ?? null,
            data.txHash,
            data.blockNumber,
            data.observedAt,
            data.treasuryIdentity,
            data.payoutReceiver,
            data.amountRaw,
            data.triggeredBy ?? null,
          ],
        )
      : await client.query<TreasuryClaimEvent>(
          `INSERT INTO treasury_claim_events (
              source_event_id,
              matched_sweep_batch_id,
              tx_hash,
              block_number,
              observed_at,
              treasury_identity,
              payout_receiver,
              amount_raw,
              triggered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
          [
            data.sourceEventId,
            data.matchedSweepBatchId ?? null,
            data.txHash,
            data.blockNumber,
            data.observedAt,
            data.treasuryIdentity,
            data.payoutReceiver,
            data.amountRaw,
            data.triggeredBy ?? null,
          ],
        );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertPartnerHandoff(data: {
  sweepBatchId: number;
  partnerName: string;
  partnerReference: string;
  handoffStatus: PartnerHandoffStatus;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<PartnerHandoff> {
  const client = await pool.connect();
  const metadata = data.metadata ?? {};
  const payloadHash = createExternalPartnerHandoffPayloadHash({
    sweepBatchId: data.sweepBatchId,
    partnerName: data.partnerName,
    partnerReference: data.partnerReference,
    handoffStatus: data.handoffStatus,
    evidenceReference: data.evidenceReference ?? null,
    metadata,
  });

  try {
    await client.query('BEGIN');

    const batchResult = await client.query<SweepBatch>(
      `SELECT *
       FROM sweep_batches
       WHERE id = $1
       FOR UPDATE`,
      [data.sweepBatchId],
    );
    const batch = batchResult.rows[0];

    if (!batch) {
      throw new Error('Sweep batch not found');
    }

    if (!batch.matched_sweep_tx_hash || !batch.matched_swept_at) {
      throw new Error('External handoff requires matched on-chain treasury claim evidence');
    }

    // WP-4 B-09 / FAIL-11. The batch handoff was last-write-wins: any status
    // overwrote any other, so a delayed callback could regress a completed
    // handoff and a FAILED arriving after a COMPLETED replaced it outright.
    const existingHandoff = await client.query<PartnerHandoff>(
      `SELECT * FROM partner_handoffs WHERE sweep_batch_id = $1 FOR UPDATE`,
      [data.sweepBatchId],
    );
    const current = existingHandoff.rows[0] ?? null;

    if (current?.frozen_at) {
      throw new PartnerHandoffConflictError(
        `External handoff for this batch is frozen pending an approved correction: ${current.frozen_reason ?? 'contradictory provider evidence'}`,
      );
    }

    assertCompletionEvidence(data.handoffStatus, {
      evidenceReference: data.evidenceReference ?? null,
    });

    const transition = classifyProviderHandoffTransition(
      current?.handoff_status ?? null,
      data.handoffStatus,
    );

    if (transition === 'CONTRADICTION') {
      const detail = `Provider reported ${data.handoffStatus} for a batch handoff already terminal at ${current?.handoff_status}`;
      await recordPartnerHandoffConflict(client, {
        scope: 'SWEEP_BATCH',
        subjectId: data.sweepBatchId,
        partnerCode: data.partnerName,
        retainedStatus: current?.handoff_status as PartnerHandoffStatus,
        conflictingStatus: data.handoffStatus,
        detail,
        actor: `provider:${data.partnerName}`,
        observedAt: new Date(),
      });
      await client.query(
        `UPDATE partner_handoffs
         SET frozen_at = COALESCE(frozen_at, NOW()),
             frozen_reason = COALESCE(frozen_reason, $2),
             updated_at = NOW()
         WHERE sweep_batch_id = $1`,
        [data.sweepBatchId, detail],
      );
      // Committed before the throw so the freeze and its reason survive the
      // refusal; a rollback would leave the batch open to the same callback.
      await client.query('COMMIT');
      throw new PartnerHandoffConflictError(detail);
    }

    if (transition === 'STALE') {
      await client.query('COMMIT');
      return current as PartnerHandoff;
    }

    const timestamp = new Date();
    const isSubmittedOrLater = ['SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING', 'COMPLETED'].includes(
      data.handoffStatus,
    );
    const isAcknowledgedOrCompleted = ['ACKNOWLEDGED', 'PROCESSING', 'COMPLETED'].includes(
      data.handoffStatus,
    );
    const isCompleted = data.handoffStatus === 'COMPLETED';
    const isFailed = ['FAILED', 'RETURNED'].includes(data.handoffStatus);
    // `verified_at` used to be set from the status alone, which recorded
    // Cotsel's own acceptance of an assertion as verification of it. Only
    // evidence the provider produced can do that.
    const isVerified = isAcknowledgedOrCompleted && Boolean(data.evidenceReference?.trim());
    const result = await client.query<PartnerHandoff>(
      `INSERT INTO partner_handoffs (
          sweep_batch_id,
          partner_name,
          partner_reference,
          handoff_status,
          latest_payload_hash,
          evidence_reference,
          submitted_at,
          acknowledged_at,
          completed_at,
          failed_at,
          verified_at,
          metadata,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12::jsonb, NOW()
        )
        ON CONFLICT (sweep_batch_id)
        DO UPDATE SET
          partner_name = EXCLUDED.partner_name,
          partner_reference = EXCLUDED.partner_reference,
          handoff_status = EXCLUDED.handoff_status,
          latest_payload_hash = EXCLUDED.latest_payload_hash,
          evidence_reference = EXCLUDED.evidence_reference,
          submitted_at = COALESCE(EXCLUDED.submitted_at, partner_handoffs.submitted_at),
          acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, partner_handoffs.acknowledged_at),
          completed_at = COALESCE(EXCLUDED.completed_at, partner_handoffs.completed_at),
          failed_at = COALESCE(EXCLUDED.failed_at, partner_handoffs.failed_at),
          verified_at = COALESCE(EXCLUDED.verified_at, partner_handoffs.verified_at),
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *`,
      [
        data.sweepBatchId,
        data.partnerName,
        data.partnerReference,
        data.handoffStatus,
        payloadHash,
        data.evidenceReference ?? null,
        isSubmittedOrLater ? timestamp : null,
        isAcknowledgedOrCompleted ? timestamp : null,
        isCompleted ? timestamp : null,
        isFailed ? timestamp : null,
        isVerified ? timestamp : null,
        JSON.stringify(metadata),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createRevenueRealization(data: {
  ledgerEntryId: number;
  accountingPeriodId: number;
  sweepBatchId?: number | null;
  partnerHandoffId?: number | null;
  actor: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<RevenueRealization> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Realization is once-per-entry. Locking the entry first makes the
    // eligibility read and the insert one decision, so two concurrent
    // realizations cannot both pass `assertRealizationAllowed`.
    await client.query(`SELECT id FROM treasury_ledger_entries WHERE id = $1 FOR UPDATE`, [
      data.ledgerEntryId,
    ]);

    const facts = await getLedgerEntryAccountingFacts(data.ledgerEntryId, client);
    if (!facts) {
      throw new Error('Ledger entry accounting facts not found');
    }

    assertRealizationAllowed({
      batchStatus: facts.sweep_batch_status,
      partnerHandoffStatus: facts.partner_handoff_status,
      bankPayoutState: facts.latest_bank_payout_state,
      revenueRealizationStatus: facts.revenue_realization_status,
    });

    if (data.accountingPeriodId !== facts.accounting_period_id) {
      throw new Error(
        'Revenue realization accounting period does not match the ledger entry batch',
      );
    }

    if (
      data.sweepBatchId !== undefined &&
      data.sweepBatchId !== null &&
      data.sweepBatchId !== facts.sweep_batch_id
    ) {
      throw new Error('Revenue realization sweep batch does not match the ledger entry batch');
    }

    if (
      data.partnerHandoffId !== undefined &&
      data.partnerHandoffId !== null &&
      data.partnerHandoffId !== facts.partner_handoff_id
    ) {
      throw new Error(
        'Revenue realization external handoff does not match the ledger entry sweep batch',
      );
    }

    const result = await rejectConcurrentWrite(
      async () =>
        client.query<RevenueRealization>(
          `INSERT INTO revenue_realizations (
          ledger_entry_id,
          accounting_period_id,
          sweep_batch_id,
          partner_handoff_id,
          realization_status,
          realized_at,
          recognized_by,
          note,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *`,
          [
            data.ledgerEntryId,
            data.accountingPeriodId,
            data.sweepBatchId ?? facts.sweep_batch_id,
            data.partnerHandoffId ?? facts.partner_handoff_id,
            'REALIZED',
            new Date(),
            data.actor,
            data.note ?? null,
            JSON.stringify(data.metadata ?? {}),
          ],
        ),
      'Ledger entry was realized concurrently',
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
