/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { CallerSafeError } from '@agroasys/shared-http';
import { createHash } from 'node:crypto';
import {
  classifyProviderHandoffTransition,
  ProviderHandoffAuthorityError,
  resolveCompletionEvidenceFailure,
  type ProviderHandoffDisposition,
} from '../../core/providerHandoffAuthority';
import { PartnerHandoffConflictError } from '../../core/treasuryPartnerHandoff';
import { recordPartnerHandoffConflict } from './partnerHandoffConflicts';
import type {
  PartnerHandoff,
  PartnerHandoffStatus,
  SweepBatch,
  TreasuryClaimEvent,
} from '../../types';
import type { PoolClient } from 'pg';
import { pool } from '../connection';

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

export interface TreasuryClaimEventUpsert {
  sourceEventId: string;
  matchedSweepBatchId?: number | null;
  txHash: string;
  blockNumber: number;
  observedAt: Date;
  treasuryIdentity: string;
  payoutReceiver: string;
  amountRaw: string;
  triggeredBy?: string | null;
}

export async function upsertTreasuryClaimEvent(
  data: TreasuryClaimEventUpsert,
): Promise<TreasuryClaimEvent> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const claimEvent = await upsertTreasuryClaimEventWith(client, data);
    await client.query('COMMIT');
    return claimEvent;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The upsert inside a caller's transaction. */
export async function upsertTreasuryClaimEventWith(
  client: PoolClient,
  data: TreasuryClaimEventUpsert,
): Promise<TreasuryClaimEvent> {
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
    throw new CallerSafeError('Treasury claim event is already matched to a different sweep batch');
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

  return result.rows[0];
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
      throw new CallerSafeError('Sweep batch not found');
    }

    if (!batch.matched_sweep_tx_hash || !batch.matched_swept_at) {
      throw new CallerSafeError(
        'External handoff requires matched on-chain treasury claim evidence',
      );
    }

    // WP-4 B-09 / FAIL-11. The batch handoff was last-write-wins: any status
    // overwrote any other, so a delayed callback could regress a completed
    // handoff and a FAILED arriving after a COMPLETED replaced it outright.
    const existingHandoff = await client.query<PartnerHandoff>(
      `SELECT * FROM partner_handoffs WHERE sweep_batch_id = $1 FOR UPDATE`,
      [data.sweepBatchId],
    );
    const current = existingHandoff.rows[0] ?? null;

    // Both refusals below used to return before the log was written, so every
    // delivery that arrived while the batch was disputed -- the ones whose
    // retention matters most -- vanished. The disposition is decided here and
    // the delivery is recorded under it; refusing comes afterwards.
    const frozenReason = current?.frozen_at
      ? `External handoff for this batch is frozen pending an approved correction: ${current.frozen_reason ?? 'contradictory provider evidence'}`
      : null;
    const evidenceFailure = frozenReason
      ? null
      : resolveCompletionEvidenceFailure(data.handoffStatus, {
          evidenceReference: data.evidenceReference ?? null,
        });

    const transition: ProviderHandoffDisposition = frozenReason
      ? 'FROZEN'
      : evidenceFailure
        ? 'REJECTED'
        : classifyProviderHandoffTransition(current?.handoff_status ?? null, data.handoffStatus);

    // Written before the verdict and never conditional on it. What a callback
    // is allowed to *do* varies; that it arrived, and what it said, does not.
    await client.query(
      `INSERT INTO partner_handoff_events (
         sweep_batch_id, partner_name, partner_reference, handoff_status,
         transition, applied, evidence_reference, payload_hash, metadata, observed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
      [
        data.sweepBatchId,
        data.partnerName,
        data.partnerReference,
        data.handoffStatus,
        transition,
        transition === 'ADVANCE',
        data.evidenceReference ?? null,
        payloadHash,
        JSON.stringify(metadata),
      ],
    );

    // Committed before each throw, for the same reason the contradiction path
    // commits: a rollback would discard the delivery that was just recorded and
    // leave the refusal unexplained.
    if (frozenReason) {
      await client.query('COMMIT');
      throw new PartnerHandoffConflictError(frozenReason);
    }

    if (evidenceFailure) {
      await client.query('COMMIT');
      throw new ProviderHandoffAuthorityError(evidenceFailure);
    }

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

    // A replayed or reordered delivery is now recorded above and stops here.
    // It used to fall through to the upsert, where `evidence_reference` and
    // `metadata` were overwritten from the incoming payload -- so a repeat
    // carrying no receipt erased the receipt the batch already had.
    if (transition === 'STALE' || transition === 'REPLAY') {
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
          evidence_reference = COALESCE(EXCLUDED.evidence_reference, partner_handoffs.evidence_reference),
          submitted_at = COALESCE(EXCLUDED.submitted_at, partner_handoffs.submitted_at),
          acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, partner_handoffs.acknowledged_at),
          completed_at = COALESCE(EXCLUDED.completed_at, partner_handoffs.completed_at),
          failed_at = COALESCE(EXCLUDED.failed_at, partner_handoffs.failed_at),
          verified_at = COALESCE(EXCLUDED.verified_at, partner_handoffs.verified_at),
          metadata = COALESCE(partner_handoffs.metadata, '{}'::jsonb) || EXCLUDED.metadata,
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

export { createRevenueRealization } from './revenueRealizations';
