/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-11. Contradictory provider evidence is written, not
 * resolved. Both writes take the caller's transaction client because the freeze
 * and the conflict record have to land with the evidence that caused them --
 * a freeze without its reason, or a reason without its freeze, is worse than
 * either alone.
 */
import type { PoolClient } from 'pg';
import type { ProviderHandoffStatus } from '../../core/providerHandoffAuthority';

export type PartnerHandoffConflictScope = 'LEDGER_ENTRY' | 'SWEEP_BATCH';

export interface PartnerHandoffConflict {
  id: number;
  record_type: 'CONFLICT' | 'CORRECTION';
  scope: PartnerHandoffConflictScope;
  subject_id: number;
  partner_code: string;
  provider_event_id: string | null;
  retained_status: ProviderHandoffStatus;
  conflicting_status: ProviderHandoffStatus;
  detail: string;
  actor: string;
  resolves_conflict_id: number | null;
  approval_reference: string | null;
  observed_at: Date;
  created_at: Date;
}

type ClientLike = Pick<PoolClient, 'query'>;

export async function recordPartnerHandoffConflict(
  client: ClientLike,
  input: {
    scope: PartnerHandoffConflictScope;
    subjectId: number;
    partnerCode: string;
    providerEventId?: string | null;
    retainedStatus: ProviderHandoffStatus;
    conflictingStatus: ProviderHandoffStatus;
    detail: string;
    actor: string;
    observedAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<PartnerHandoffConflict> {
  const result = await client.query<PartnerHandoffConflict>(
    `INSERT INTO treasury_partner_handoff_conflicts (
       record_type, scope, subject_id, partner_code, provider_event_id,
       retained_status, conflicting_status, detail, actor, metadata, observed_at
     )
     VALUES ('CONFLICT', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING *`,
    [
      input.scope,
      input.subjectId,
      input.partnerCode,
      input.providerEventId ?? null,
      input.retainedStatus,
      input.conflictingStatus,
      input.detail,
      input.actor,
      JSON.stringify(input.metadata ?? {}),
      input.observedAt,
    ],
  );

  return result.rows[0];
}

export async function listPartnerHandoffConflicts(
  client: ClientLike,
  scope: PartnerHandoffConflictScope,
  subjectId: number,
): Promise<PartnerHandoffConflict[]> {
  const result = await client.query<PartnerHandoffConflict>(
    `SELECT *
     FROM treasury_partner_handoff_conflicts
     WHERE scope = $1 AND subject_id = $2
     ORDER BY id ASC`,
    [scope, subjectId],
  );

  return result.rows;
}

export async function recordPartnerHandoffCorrection(
  client: ClientLike,
  input: {
    scope: PartnerHandoffConflictScope;
    subjectId: number;
    partnerCode: string;
    resolvesConflictId: number;
    approvalReference: string;
    retainedStatus: ProviderHandoffStatus;
    conflictingStatus: ProviderHandoffStatus;
    detail: string;
    actor: string;
    observedAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<PartnerHandoffConflict> {
  const result = await client.query<PartnerHandoffConflict>(
    `INSERT INTO treasury_partner_handoff_conflicts (
       record_type, scope, subject_id, partner_code, provider_event_id,
       retained_status, conflicting_status, detail, actor,
       resolves_conflict_id, approval_reference, metadata, observed_at
     )
     VALUES ('CORRECTION', $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING *`,
    [
      input.scope,
      input.subjectId,
      input.partnerCode,
      input.retainedStatus,
      input.conflictingStatus,
      input.detail,
      input.actor,
      input.resolvesConflictId,
      input.approvalReference,
      JSON.stringify(input.metadata ?? {}),
      input.observedAt,
    ],
  );

  return result.rows[0];
}
