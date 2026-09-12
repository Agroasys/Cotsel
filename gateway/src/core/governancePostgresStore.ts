/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import {
  ACTIVE_PROPOSAL_STATUSES,
  decodeGovernanceActionCursor,
  GOVERNANCE_OPEN_INTENT_STATUSES,
  type GovernanceActionRow,
  type GovernanceActionStore,
  mapGovernanceActionRow,
  nextGovernanceActionCursor,
  numericOrNull,
} from './governanceStore';

export function createPostgresGovernanceActionStore(pool: Pool): GovernanceActionStore {
  const selectColumns = `SELECT
    action_id AS "actionId",
    intent_key AS "intentKey",
    intent_hash AS "intentHash",
    proposal_id AS "proposalId",
    category,
    status,
    COALESCE(flow_type, 'direct_sign') AS "flowType",
    contract_method AS "contractMethod",
    tx_hash AS "txHash",
    block_number AS "blockNumber",
    trade_id AS "tradeId",
    chain_id AS "chainId",
    target_address AS "targetAddress",
    broadcast_at AS "broadcastAt",
    request_id AS "requestId",
    correlation_id AS "correlationId",
    idempotency_key AS "idempotencyKey",
    actor_id AS "actorId",
    endpoint AS "endpoint",
    reason,
    evidence_links AS "evidenceLinks",
    ticket_ref AS "ticketRef",
    actor_session_id AS "actorSessionId",
    actor_wallet AS "actorWallet",
    actor_role AS "actorRole",
    requested_by AS "requestedBy",
    approved_by AS "approvedBy",
    actor_account_id AS "actorAccountId",
    signer_policy_evidence AS "signerPolicyEvidence",
    final_signer_wallet AS "finalSignerWallet",
    verification_state AS "verificationState",
    verification_error AS "verificationError",
    verified_at AS "verifiedAt",
    monitoring_state AS "monitoringState",
    prepared_signing_payload AS "signing",
    error_code AS "errorCode",
    error_message AS "errorMessage",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    executed_at AS "executedAt"`;

  return {
    async save(action) {
      await pool.query(
        `INSERT INTO governance_actions (
          action_id,
          intent_key,
          intent_hash,
          proposal_id,
          category,
          status,
          flow_type,
          contract_method,
          tx_hash,
          block_number,
          trade_id,
          chain_id,
          target_address,
          broadcast_at,
          request_id,
          correlation_id,
          idempotency_key,
          actor_id,
          endpoint,
          reason,
          evidence_links,
          ticket_ref,
          actor_session_id,
          actor_wallet,
          actor_role,
          requested_by,
          approved_by,
          actor_account_id,
          signer_policy_evidence,
          final_signer_wallet,
          verification_state,
          verification_error,
          verified_at,
          monitoring_state,
          prepared_signing_payload,
          error_code,
          error_message,
          created_at,
          expires_at,
          executed_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22,
          $23, $24, $25, $26, $27::jsonb, $28, $29::jsonb, $30, $31, $32, $33, $34, $35::jsonb,
          $36, $37, $38, $39, $40, NOW()
        )
        ON CONFLICT (action_id) DO UPDATE SET
          intent_key = EXCLUDED.intent_key,
          intent_hash = EXCLUDED.intent_hash,
          proposal_id = EXCLUDED.proposal_id,
          category = EXCLUDED.category,
          status = EXCLUDED.status,
          flow_type = EXCLUDED.flow_type,
          contract_method = EXCLUDED.contract_method,
          tx_hash = EXCLUDED.tx_hash,
          block_number = EXCLUDED.block_number,
          trade_id = EXCLUDED.trade_id,
          chain_id = EXCLUDED.chain_id,
          target_address = EXCLUDED.target_address,
          broadcast_at = EXCLUDED.broadcast_at,
          request_id = EXCLUDED.request_id,
          correlation_id = EXCLUDED.correlation_id,
          idempotency_key = EXCLUDED.idempotency_key,
          actor_id = EXCLUDED.actor_id,
          endpoint = EXCLUDED.endpoint,
          reason = EXCLUDED.reason,
          evidence_links = EXCLUDED.evidence_links,
          ticket_ref = EXCLUDED.ticket_ref,
          actor_session_id = EXCLUDED.actor_session_id,
          actor_wallet = EXCLUDED.actor_wallet,
          actor_role = EXCLUDED.actor_role,
          requested_by = EXCLUDED.requested_by,
          approved_by = EXCLUDED.approved_by,
          actor_account_id = EXCLUDED.actor_account_id,
          signer_policy_evidence = EXCLUDED.signer_policy_evidence,
          final_signer_wallet = EXCLUDED.final_signer_wallet,
          verification_state = EXCLUDED.verification_state,
          verification_error = EXCLUDED.verification_error,
          verified_at = EXCLUDED.verified_at,
          monitoring_state = EXCLUDED.monitoring_state,
          prepared_signing_payload = EXCLUDED.prepared_signing_payload,
          error_code = EXCLUDED.error_code,
          error_message = EXCLUDED.error_message,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          executed_at = EXCLUDED.executed_at,
          updated_at = NOW()`,
        [
          action.actionId,
          action.intentKey,
          action.intentHash ?? null,
          action.proposalId,
          action.category,
          action.status,
          action.flowType,
          action.contractMethod,
          action.txHash,
          action.blockNumber,
          action.tradeId,
          action.chainId,
          action.targetAddress,
          action.broadcastAt,
          action.requestId,
          action.correlationId,
          action.idempotencyKey ?? null,
          action.actorId ?? null,
          action.endpoint ?? null,
          action.audit.reason,
          JSON.stringify(action.audit.evidenceLinks),
          action.audit.ticketRef,
          action.audit.actorSessionId,
          action.audit.actorWallet,
          action.audit.actorRole,
          action.audit.requestedBy,
          JSON.stringify(action.audit.approvedBy ?? []),
          action.audit.actorAccountId ?? null,
          JSON.stringify({
            signerBindingId: action.audit.signerBindingId ?? null,
            signerActionClass: action.audit.signerActionClass ?? null,
            signerEnvironment: action.audit.signerEnvironment ?? null,
            signerPolicyResult: action.audit.signerPolicyResult ?? null,
            signerPolicyReason: action.audit.signerPolicyReason ?? null,
            signerBindingWallet: action.audit.signerBindingWallet ?? null,
            breakGlassActive: action.audit.breakGlassActive ?? false,
            breakGlassReason: action.audit.breakGlassReason ?? null,
            breakGlassExpiresAt: action.audit.breakGlassExpiresAt ?? null,
            breakGlassReviewedAt: action.audit.breakGlassReviewedAt ?? null,
            breakGlassReviewedBy: action.audit.breakGlassReviewedBy ?? null,
            breakGlassReviewStatus: action.audit.breakGlassReviewStatus ?? null,
          }),
          action.finalSignerWallet ?? null,
          action.verificationState ?? 'not_started',
          action.verificationError ?? null,
          action.verifiedAt ?? null,
          action.monitoringState ?? 'not_started',
          action.signing ? JSON.stringify(action.signing) : null,
          action.errorCode,
          action.errorMessage,
          action.createdAt,
          action.expiresAt,
          action.executedAt,
        ],
      );

      const stored = await this.get(action.actionId);
      if (!stored) {
        throw new Error(`Failed to persist governance action ${action.actionId}`);
      }

      return stored;
    },

    async get(actionId) {
      const result = await pool.query<GovernanceActionRow>(
        `${selectColumns}
         FROM governance_actions
         WHERE action_id = $1`,
        [actionId],
      );

      return result.rows[0] ? mapGovernanceActionRow(result.rows[0]) : null;
    },

    async findOpenByIntentKey(intentKey, now) {
      const result = await pool.query<GovernanceActionRow>(
        `${selectColumns}
         FROM governance_actions
         WHERE intent_key = $1
           AND status = ANY($2::text[])
           AND (status <> 'prepared' OR expires_at > $3::timestamp)
         ORDER BY created_at DESC, action_id DESC
         LIMIT 1`,
        [intentKey, GOVERNANCE_OPEN_INTENT_STATUSES, now],
      );

      return result.rows[0] ? mapGovernanceActionRow(result.rows[0]) : null;
    },

    async list(input) {
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (input.category) {
        values.push(input.category);
        conditions.push(`category = $${values.length}`);
      }

      if (input.categories && input.categories.length > 0) {
        values.push(input.categories);
        conditions.push(`category = ANY($${values.length}::text[])`);
      }

      if (input.status) {
        values.push(input.status);
        conditions.push(`status = $${values.length}`);
      }

      if (input.tradeId) {
        values.push(input.tradeId);
        conditions.push(`trade_id = $${values.length}`);
      }

      if (input.cursor) {
        const cursor = decodeGovernanceActionCursor(input.cursor);
        values.push(cursor.createdAt);
        const createdAtIndex = values.length;
        values.push(cursor.actionId);
        const actionIdIndex = values.length;
        conditions.push(
          `(created_at < $${createdAtIndex}::timestamp OR (created_at = $${createdAtIndex}::timestamp AND action_id < $${actionIdIndex}))`,
        );
      }

      values.push(input.limit + 1);
      const limitIndex = values.length;

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query<GovernanceActionRow>(
        `${selectColumns}
         FROM governance_actions
         ${whereClause}
         ORDER BY created_at DESC, action_id DESC
         LIMIT $${limitIndex}`,
        values,
      );

      const mapped = result.rows.map(mapGovernanceActionRow);
      return {
        items: mapped.slice(0, input.limit),
        nextCursor: nextGovernanceActionCursor(mapped, input.limit),
      };
    },

    async listActiveProposalIds(category) {
      const result = await pool.query<{ proposalId: string | number }>(
        `SELECT DISTINCT proposal_id AS "proposalId"
         FROM governance_actions
         WHERE category = $1
           AND proposal_id IS NOT NULL
           AND status = ANY($2::text[])
         ORDER BY proposal_id ASC`,
        [category, ACTIVE_PROPOSAL_STATUSES],
      );

      return result.rows
        .map((row) => numericOrNull(row.proposalId))
        .filter((value): value is number => value !== null);
    },
  };
}
