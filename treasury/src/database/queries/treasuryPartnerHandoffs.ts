/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createTreasuryPartnerHandoffEvidencePayloadHash,
  createTreasuryPartnerHandoffPayloadHash,
  TreasuryPartnerHandoffConflictError,
} from '../../core/treasuryPartnerHandoff';
import {
  assertCompletionEvidence,
  classifyProviderHandoffTransition,
  isHandoffComplete,
  ProviderHandoffAuthorityError,
  type ProviderHandoffTransition,
} from '../../core/providerHandoffAuthority';
import { retryOnceOnUniqueViolation } from '../../core/transitionConcurrency';
import { recordPartnerHandoffConflict } from './partnerHandoffConflicts';
import type {
  LedgerEntry,
  TreasuryPartnerHandoff,
  TreasuryPartnerHandoffEvidenceInput,
  TreasuryPartnerHandoffEvent,
  TreasuryPartnerHandoffInput,
} from '../../types';
import { pool } from '../connection';

export async function getTreasuryPartnerHandoffByLedgerEntryId(
  ledgerEntryId: number,
): Promise<TreasuryPartnerHandoff | null> {
  const result = await pool.query<TreasuryPartnerHandoff>(
    `SELECT *
     FROM treasury_partner_handoffs
     WHERE ledger_entry_id = $1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function listTreasuryPartnerHandoffEventsByLedgerEntryId(
  ledgerEntryId: number,
): Promise<TreasuryPartnerHandoffEvent[]> {
  const result = await pool.query<TreasuryPartnerHandoffEvent>(
    `SELECT *
     FROM treasury_partner_handoff_events
     WHERE ledger_entry_id = $1
     ORDER BY observed_at ASC, id ASC`,
    [ledgerEntryId],
  );

  return result.rows;
}

export interface TreasuryPartnerHandoffUpsertResult {
  handoff: TreasuryPartnerHandoff;
  created: boolean;
  idempotentReplay: boolean;
}

export async function upsertTreasuryPartnerHandoff(
  data: TreasuryPartnerHandoffInput,
): Promise<TreasuryPartnerHandoffUpsertResult> {
  return retryOnceOnUniqueViolation(
    () => upsertTreasuryPartnerHandoffOnce(data),
    'Treasury partner handoff was created concurrently for this ledger entry',
  );
}

async function upsertTreasuryPartnerHandoffOnce(
  data: TreasuryPartnerHandoffInput,
): Promise<TreasuryPartnerHandoffUpsertResult> {
  const normalized = {
    ledgerEntryId: data.ledgerEntryId,
    partnerCode: data.partnerCode,
    handoffReference: data.handoffReference.trim(),
    partnerStatus: data.partnerStatus,
    payoutReference: data.payoutReference?.trim() || null,
    transferReference: data.transferReference?.trim() || null,
    drainReference: data.drainReference?.trim() || null,
    destinationExternalAccountId: data.destinationExternalAccountId?.trim() || null,
    liquidationAddressId: data.liquidationAddressId?.trim() || null,
    sourceAmount: data.sourceAmount?.trim() || null,
    sourceCurrency: data.sourceCurrency?.trim().toUpperCase() || null,
    destinationAmount: data.destinationAmount?.trim() || null,
    destinationCurrency: data.destinationCurrency?.trim().toUpperCase() || null,
    actor: data.actor.trim(),
    note: data.note?.trim() || null,
    failureCode: data.failureCode?.trim() || null,
    initiatedAt: data.initiatedAt,
    metadata: data.metadata ?? {},
  };
  // WP-4 B-09 / FAIL-11. This route records the *intent* to hand off, under
  // internal service auth alone -- no provider signature is involved, and the
  // input carries no evidence reference or bank reference for one to be checked
  // against. Completion is therefore not something it can assert: a `COMPLETED`
  // here would enter the authoritative state, and the accounting projection,
  // with nothing external corroborating it. Completion arrives only through the
  // provider-signed evidence route, where `assertCompletionEvidence` applies.
  if (isHandoffComplete(normalized.partnerStatus)) {
    throw new ProviderHandoffAuthorityError(
      'External handoff cannot be created as COMPLETED; completion requires provider-signed evidence through the handoff evidence route',
    );
  }

  const payloadHash = createTreasuryPartnerHandoffPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // The handoff is unique per ledger entry, so the entry row is the natural
    // lock for "does this entry already have a handoff, and may I create one".
    const ledgerEntryResult = await client.query<LedgerEntry>(
      `SELECT * FROM treasury_ledger_entries WHERE id = $1 FOR UPDATE`,
      [normalized.ledgerEntryId],
    );
    if (!ledgerEntryResult.rows[0]) {
      throw new Error('Ledger entry not found');
    }

    const existing = await client.query<TreasuryPartnerHandoff>(
      `SELECT *
       FROM treasury_partner_handoffs
       WHERE ledger_entry_id = $1`,
      [normalized.ledgerEntryId],
    );

    if (existing.rows[0]) {
      if (existing.rows[0].latest_event_payload_hash !== payloadHash) {
        throw new TreasuryPartnerHandoffConflictError(
          'Treasury partner handoff already exists with conflicting payload',
        );
      }

      await client.query('COMMIT');
      return {
        handoff: existing.rows[0],
        created: false,
        idempotentReplay: true,
      };
    }

    const result = await client.query<TreasuryPartnerHandoff>(
      `INSERT INTO treasury_partner_handoffs (
          ledger_entry_id,
          partner_code,
          handoff_reference,
          partner_status,
          payout_reference,
          transfer_reference,
          drain_reference,
          destination_external_account_id,
          liquidation_address_id,
          source_amount,
          source_currency,
          destination_amount,
          destination_currency,
          actor,
          note,
          failure_code,
          latest_event_payload_hash,
          metadata,
          initiated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19
        )
        RETURNING *`,
      [
        normalized.ledgerEntryId,
        normalized.partnerCode,
        normalized.handoffReference,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.sourceAmount,
        normalized.sourceCurrency,
        normalized.destinationAmount,
        normalized.destinationCurrency,
        normalized.actor,
        normalized.note,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
        normalized.initiatedAt,
      ],
    );

    await client.query('COMMIT');

    return {
      handoff: result.rows[0],
      created: true,
      idempotentReplay: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface TreasuryPartnerHandoffEvidenceResult {
  handoff: TreasuryPartnerHandoff;
  event: TreasuryPartnerHandoffEvent;
  created: boolean;
  idempotentReplay: boolean;
  /** How the append-only state machine judged this callback. */
  transition: ProviderHandoffTransition;
  /** Whether it became the authoritative state. A recorded event that did not. */
  applied: boolean;
}

export async function appendTreasuryPartnerHandoffEvidence(
  data: TreasuryPartnerHandoffEvidenceInput,
): Promise<TreasuryPartnerHandoffEvidenceResult> {
  return retryOnceOnUniqueViolation(
    () => appendTreasuryPartnerHandoffEvidenceOnce(data),
    'Treasury partner evidence event was recorded concurrently',
  );
}

async function appendTreasuryPartnerHandoffEvidenceOnce(
  data: TreasuryPartnerHandoffEvidenceInput,
): Promise<TreasuryPartnerHandoffEvidenceResult> {
  const normalized = {
    ledgerEntryId: data.ledgerEntryId,
    partnerCode: data.partnerCode,
    providerEventId: data.providerEventId.trim(),
    eventType: data.eventType.trim(),
    partnerStatus: data.partnerStatus,
    payoutReference: data.payoutReference?.trim() || null,
    transferReference: data.transferReference?.trim() || null,
    drainReference: data.drainReference?.trim() || null,
    destinationExternalAccountId: data.destinationExternalAccountId?.trim() || null,
    liquidationAddressId: data.liquidationAddressId?.trim() || null,
    bankReference: data.bankReference?.trim() || null,
    bankState: data.bankState ?? null,
    evidenceReference: data.evidenceReference?.trim() || null,
    failureCode: data.failureCode?.trim() || null,
    observedAt: data.observedAt,
    metadata: data.metadata ?? {},
  };
  // A completion is the one claim that says value left Cotsel's control, so it
  // is refused outright unless the provider or the bank corroborated it.
  assertCompletionEvidence(normalized.partnerStatus, {
    evidenceReference: normalized.evidenceReference,
    bankReference: normalized.bankReference,
  });

  const payloadHash = createTreasuryPartnerHandoffEvidencePayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingEvent = await client.query<TreasuryPartnerHandoffEvent>(
      `SELECT *
       FROM treasury_partner_handoff_events
       WHERE provider_event_id = $1`,
      [normalized.providerEventId],
    );

    if (existingEvent.rows[0]) {
      if (existingEvent.rows[0].payload_hash !== payloadHash) {
        throw new TreasuryPartnerHandoffConflictError(
          'Duplicate treasury partner evidence event with conflicting payload',
        );
      }

      const existingHandoff = await client.query<TreasuryPartnerHandoff>(
        `SELECT *
         FROM treasury_partner_handoffs
         WHERE id = $1`,
        [existingEvent.rows[0].partner_handoff_id],
      );

      await client.query('COMMIT');
      return {
        handoff: existingHandoff.rows[0],
        event: existingEvent.rows[0],
        created: false,
        idempotentReplay: true,
        transition: 'REPLAY',
        applied: false,
      };
    }

    // Provider events for one handoff arrive concurrently and each one rewrites
    // the handoff's latest status. Locking the handoff row serialises them so
    // the last event applied is the last event recorded.
    const handoffResult = await client.query<TreasuryPartnerHandoff>(
      `SELECT *
       FROM treasury_partner_handoffs
       WHERE ledger_entry_id = $1
       FOR UPDATE`,
      [normalized.ledgerEntryId],
    );

    const handoff = handoffResult.rows[0];
    if (!handoff) {
      throw new Error('Treasury partner handoff not found');
    }

    const eventResult = await client.query<TreasuryPartnerHandoffEvent>(
      `INSERT INTO treasury_partner_handoff_events (
          partner_handoff_id,
          ledger_entry_id,
          partner_code,
          provider_event_id,
          event_type,
          partner_status,
          payout_reference,
          transfer_reference,
          drain_reference,
          destination_external_account_id,
          liquidation_address_id,
          bank_reference,
          bank_state,
          evidence_reference,
          failure_code,
          payload_hash,
          metadata,
          observed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
        )
        RETURNING *`,
      [
        handoff.id,
        normalized.ledgerEntryId,
        normalized.partnerCode,
        normalized.providerEventId,
        normalized.eventType,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.bankReference,
        normalized.bankState,
        normalized.evidenceReference,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
        normalized.observedAt,
      ],
    );

    // The evidence row above is written before any verdict is reached, and it
    // is never conditional on one. What the callback is allowed to *do* varies;
    // that it arrived, and what it said, does not.
    const transition = handoff.frozen_at
      ? ('STALE' as ProviderHandoffTransition)
      : classifyProviderHandoffTransition(handoff.partner_status, normalized.partnerStatus);

    if (transition === 'CONTRADICTION') {
      const detail = `Provider reported ${normalized.partnerStatus} for a handoff already terminal at ${handoff.partner_status}`;
      await recordPartnerHandoffConflict(client, {
        scope: 'LEDGER_ENTRY',
        subjectId: normalized.ledgerEntryId,
        partnerCode: normalized.partnerCode,
        providerEventId: normalized.providerEventId,
        retainedStatus: handoff.partner_status,
        conflictingStatus: normalized.partnerStatus,
        detail,
        actor: `provider:${normalized.partnerCode}`,
        observedAt: normalized.observedAt,
      });

      await client.query(
        `UPDATE treasury_partner_handoffs
         SET frozen_at = COALESCE(frozen_at, NOW()),
             frozen_reason = COALESCE(frozen_reason, $2),
             updated_at = NOW()
         WHERE id = $1`,
        [handoff.id, detail],
      );

      // Committed before the throw on purpose. Rolling back would discard the
      // very evidence the conflict is about, leaving an unexplained refusal and
      // a handoff that the next identical callback would freeze all over again.
      await client.query('COMMIT');
      throw new TreasuryPartnerHandoffConflictError(detail);
    }

    // ADVANCE is the only transition that moves the authoritative state. A
    // REPLAY or a delayed, reordered callback fills in references it can add
    // without regressing the state that has already been established.
    const applied = transition === 'ADVANCE';
    const updatedHandoff = await client.query<TreasuryPartnerHandoff>(
      `UPDATE treasury_partner_handoffs
       SET
         partner_status = CASE WHEN $11 THEN $2 ELSE partner_status END,
         payout_reference = COALESCE(payout_reference, $3),
         transfer_reference = COALESCE(transfer_reference, $4),
         drain_reference = COALESCE(drain_reference, $5),
         destination_external_account_id = COALESCE(destination_external_account_id, $6),
         liquidation_address_id = COALESCE(liquidation_address_id, $7),
         failure_code = COALESCE(failure_code, $8),
         latest_event_payload_hash = CASE WHEN $11 THEN $9 ELSE latest_event_payload_hash END,
         metadata = COALESCE(metadata, '{}'::jsonb) || $10::jsonb,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        handoff.id,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
        applied,
      ],
    );

    await client.query('COMMIT');

    return {
      handoff: updatedHandoff.rows[0],
      event: eventResult.rows[0],
      created: true,
      idempotentReplay: false,
      transition,
      applied,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
