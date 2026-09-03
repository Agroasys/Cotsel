/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createTreasuryPartnerHandoffEvidencePayloadHash,
  createTreasuryPartnerHandoffPayloadHash,
  TreasuryPartnerHandoffConflictError,
} from '../../core/treasuryPartnerHandoff';
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

export async function upsertTreasuryPartnerHandoff(data: TreasuryPartnerHandoffInput): Promise<{
  handoff: TreasuryPartnerHandoff;
  created: boolean;
  idempotentReplay: boolean;
}> {
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
  const payloadHash = createTreasuryPartnerHandoffPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const ledgerEntryResult = await client.query<LedgerEntry>(
      `SELECT * FROM treasury_ledger_entries WHERE id = $1`,
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

export async function appendTreasuryPartnerHandoffEvidence(
  data: TreasuryPartnerHandoffEvidenceInput,
): Promise<{
  handoff: TreasuryPartnerHandoff;
  event: TreasuryPartnerHandoffEvent;
  created: boolean;
  idempotentReplay: boolean;
}> {
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
      };
    }

    const handoffResult = await client.query<TreasuryPartnerHandoff>(
      `SELECT *
       FROM treasury_partner_handoffs
       WHERE ledger_entry_id = $1`,
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

    const updatedHandoff = await client.query<TreasuryPartnerHandoff>(
      `UPDATE treasury_partner_handoffs
       SET
         partner_status = $2,
         payout_reference = COALESCE($3, payout_reference),
         transfer_reference = COALESCE($4, transfer_reference),
         drain_reference = COALESCE($5, drain_reference),
         destination_external_account_id = COALESCE($6, destination_external_account_id),
         liquidation_address_id = COALESCE($7, liquidation_address_id),
         failure_code = COALESCE($8, failure_code),
         latest_event_payload_hash = $9,
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
      ],
    );

    await client.query('COMMIT');

    return {
      handoff: updatedHandoff.rows[0],
      event: eventResult.rows[0],
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
