/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AuditLogEntry, AuditLogStore } from './auditLogStore';
import {
  GovernanceActionRecord,
  GovernanceActionStore,
  GOVERNANCE_OPEN_INTENT_STATUSES,
} from './governanceStore';

export interface GovernanceWriteStore {
  saveActionWithAudit(
    action: GovernanceActionRecord,
    auditEntry: AuditLogEntry,
  ): Promise<GovernanceActionRecord>;
  saveQueuedActionWithIntentDedupe(
    action: GovernanceActionRecord,
    auditEntry: AuditLogEntry,
    duplicateAuditEntry: (existing: GovernanceActionRecord) => AuditLogEntry,
    now: string,
  ): Promise<{ action: GovernanceActionRecord; created: boolean }>;
  saveDirectSignActionWithIntentDedupe(
    action: GovernanceActionRecord,
    auditEntry: AuditLogEntry,
    duplicateAuditEntry: (existing: GovernanceActionRecord) => AuditLogEntry,
    now: string,
  ): Promise<{ action: GovernanceActionRecord; created: boolean }>;
}

function governanceActionParams(action: GovernanceActionRecord): unknown[] {
  return [
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
    action.finalSignerWallet ?? null,
    action.verificationState ??
      (action.flowType === 'direct_sign' ? 'not_started' : 'not_required'),
    action.verificationError ?? null,
    action.verifiedAt ?? null,
    action.monitoringState ?? (action.flowType === 'direct_sign' ? 'not_started' : 'not_required'),
    action.signing ? JSON.stringify(action.signing) : null,
    action.errorCode,
    action.errorMessage,
    action.createdAt,
    action.expiresAt,
    action.executedAt,
  ];
}

async function upsertGovernanceAction(
  client: PoolClient,
  action: GovernanceActionRecord,
): Promise<void> {
  await client.query(
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
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb,
      $23, $24, $25, $26, $27, $28::jsonb, $29, $30, $31, $32, $33, $34::jsonb,
      $35, $36, $37, $38, $39, NOW()
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
    governanceActionParams(action),
  );
}

async function insertAuditLog(client: PoolClient, entry: AuditLogEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (
      event_type,
      route,
      method,
      request_id,
      correlation_id,
      action_id,
      idempotency_key,
      actor_id,
      actor_user_id,
      actor_wallet_address,
      actor_role,
      status,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      entry.eventType,
      entry.route,
      entry.method,
      entry.requestId,
      entry.correlationId || null,
      entry.actionId || null,
      entry.idempotencyKey || null,
      entry.actorId || null,
      entry.actorUserId || null,
      entry.actorWalletAddress || null,
      entry.actorRole || null,
      entry.status,
      JSON.stringify(entry.metadata || {}),
    ],
  );
}

export function createPostgresGovernanceWriteStore(
  pool: Pool,
  readStore: GovernanceActionStore,
): GovernanceWriteStore {
  async function loadExistingOpenIntentAction(
    client: PoolClient,
    intentKey: string,
    now: string,
  ): Promise<{ actionId: string } | null> {
    const result = await client.query<{ actionId: string }>(
      `SELECT action_id AS "actionId"
       FROM governance_actions
       WHERE intent_key = $1
         AND status = ANY($2::text[])
         AND (
           status NOT IN ('requested', 'prepared')
           OR expires_at IS NULL
           OR expires_at > $3::timestamp
         )
       ORDER BY created_at DESC, action_id DESC
       LIMIT 1`,
      [intentKey, GOVERNANCE_OPEN_INTENT_STATUSES, now],
    );

    return result.rows[0] ?? null;
  }

  return {
    async saveActionWithAudit(action, auditEntry) {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await upsertGovernanceAction(client, action);
        await insertAuditLog(client, auditEntry);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Governance write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`,
          );
        }

        throw error;
      } finally {
        client.release();
      }

      const stored = await readStore.get(action.actionId);
      if (!stored) {
        throw new Error(`Failed to persist governance action ${action.actionId}`);
      }

      return stored;
    },

    async saveQueuedActionWithIntentDedupe(action, auditEntry, duplicateAuditEntry, now) {
      const client = await pool.connect();
      let existingActionId: string | null = null;
      let created = false;

      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [action.intentKey]);

        const existing = await loadExistingOpenIntentAction(client, action.intentKey, now);
        if (existing) {
          existingActionId = existing.actionId;
          const storedExisting = await readStore.get(existing.actionId);
          if (!storedExisting) {
            throw new Error(
              `Failed to load governance action ${existing.actionId} for semantic dedupe`,
            );
          }
          await insertAuditLog(client, duplicateAuditEntry(storedExisting));
        } else {
          await upsertGovernanceAction(client, action);
          await insertAuditLog(client, auditEntry);
          created = true;
          existingActionId = action.actionId;
        }

        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Governance write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`,
          );
        }

        throw error;
      } finally {
        client.release();
      }

      const stored = existingActionId ? await readStore.get(existingActionId) : null;
      if (!stored) {
        throw new Error(
          `Failed to persist governance action ${existingActionId ?? action.actionId}`,
        );
      }

      return {
        action: stored,
        created,
      };
    },

    async saveDirectSignActionWithIntentDedupe(action, auditEntry, duplicateAuditEntry, now) {
      const client = await pool.connect();
      let existingActionId: string | null = null;
      let created = false;

      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [action.intentKey]);

        const existing = await loadExistingOpenIntentAction(client, action.intentKey, now);
        if (existing) {
          existingActionId = existing.actionId;
          const storedExisting = await readStore.get(existing.actionId);
          if (!storedExisting) {
            throw new Error(
              `Failed to load governance action ${existing.actionId} for semantic dedupe`,
            );
          }
          await insertAuditLog(client, duplicateAuditEntry(storedExisting));
        } else {
          await upsertGovernanceAction(client, action);
          await insertAuditLog(client, auditEntry);
          created = true;
          existingActionId = action.actionId;
        }

        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Governance direct-sign write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`,
          );
        }

        throw error;
      } finally {
        client.release();
      }

      const stored = existingActionId ? await readStore.get(existingActionId) : null;
      if (!stored) {
        throw new Error(
          `Failed to persist direct-sign governance action ${existingActionId ?? action.actionId}`,
        );
      }

      return {
        action: stored,
        created,
      };
    },
  };
}

export function createPassthroughGovernanceWriteStore(
  actionStore: GovernanceActionStore,
  auditLogStore: AuditLogStore,
): GovernanceWriteStore {
  return {
    async saveActionWithAudit(action, auditEntry) {
      const stored = await actionStore.save(action);
      await auditLogStore.append(auditEntry);
      return stored;
    },

    async saveQueuedActionWithIntentDedupe(action, auditEntry, duplicateAuditEntry, now) {
      const existing = await actionStore.findOpenByIntentKey(action.intentKey, now);
      if (existing) {
        await auditLogStore.append(duplicateAuditEntry(existing));
        return {
          action: existing,
          created: false,
        };
      }

      const stored = await actionStore.save(action);
      await auditLogStore.append(auditEntry);
      return {
        action: stored,
        created: true,
      };
    },

    async saveDirectSignActionWithIntentDedupe(action, auditEntry, duplicateAuditEntry, now) {
      const existing = await actionStore.findOpenByIntentKey(action.intentKey, now);
      if (existing) {
        await auditLogStore.append(duplicateAuditEntry(existing));
        return {
          action: existing,
          created: false,
        };
      }

      const stored = await actionStore.save(action);
      await auditLogStore.append(auditEntry);
      return {
        action: stored,
        created: true,
      };
    },
  };
}
