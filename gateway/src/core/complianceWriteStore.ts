/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool, PoolClient } from 'pg';
import { AuditLogEntry, AuditLogStore } from './auditLogStore';
import {
  ComplianceDecisionRecord,
  ComplianceStore,
  OracleProgressionBlockRecord,
} from './complianceStore';

export interface ComplianceWriteStore {
  saveDecisionWithAudit(decision: ComplianceDecisionRecord, auditEntry: AuditLogEntry): Promise<ComplianceDecisionRecord>;
  saveBlockStateWithAudit(block: OracleProgressionBlockRecord, auditEntry: AuditLogEntry): Promise<OracleProgressionBlockRecord>;
}

async function insertAuditLog(client: PoolClient, entry: AuditLogEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (
      event_type,
      route,
      method,
      request_id,
      correlation_id,
      actor_user_id,
      actor_wallet_address,
      actor_role,
      status,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      entry.eventType,
      entry.route,
      entry.method,
      entry.requestId,
      entry.correlationId || null,
      entry.actorUserId || null,
      entry.actorWalletAddress || null,
      entry.actorRole || null,
      entry.status,
      JSON.stringify(entry.metadata || {}),
    ],
  );
}

async function insertComplianceDecision(client: PoolClient, decision: ComplianceDecisionRecord): Promise<void> {
  await client.query(
    `INSERT INTO compliance_decisions (
      decision_id,
      trade_id,
      decision_type,
      result,
      reason_code,
      provider,
      provider_ref,
      subject_id,
      subject_type,
      risk_level,
      correlation_id,
      override_window_ends_at,
      reason,
      evidence_links,
      ticket_ref,
      actor_session_id,
      actor_wallet,
      actor_role,
      requested_by,
      approved_by,
      decided_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20::jsonb, $21
    )`,
    [
      decision.decisionId,
      decision.tradeId,
      decision.decisionType,
      decision.result,
      decision.reasonCode,
      decision.provider,
      decision.providerRef,
      decision.subjectId,
      decision.subjectType,
      decision.riskLevel,
      decision.correlationId,
      decision.overrideWindowEndsAt,
      decision.audit.reason,
      JSON.stringify(decision.audit.evidenceLinks),
      decision.audit.ticketRef,
      decision.audit.actorSessionId,
      decision.audit.actorWallet,
      decision.audit.actorRole,
      decision.audit.requestedBy,
      JSON.stringify(decision.audit.approvedBy ?? []),
      decision.decidedAt,
    ],
  );
}

async function upsertOracleProgressionBlock(client: PoolClient, block: OracleProgressionBlockRecord): Promise<void> {
  await client.query(
    `INSERT INTO oracle_progression_blocks (
      trade_id,
      latest_decision_id,
      block_state,
      reason_code,
      request_id,
      correlation_id,
      audit_reason,
      evidence_links,
      ticket_ref,
      actor_session_id,
      actor_wallet,
      actor_role,
      requested_by,
      approved_by,
      blocked_at,
      resumed_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
      $11, $12, $13, $14::jsonb, $15, $16, $17
    )
    ON CONFLICT (trade_id) DO UPDATE SET
      latest_decision_id = EXCLUDED.latest_decision_id,
      block_state = EXCLUDED.block_state,
      reason_code = EXCLUDED.reason_code,
      request_id = EXCLUDED.request_id,
      correlation_id = EXCLUDED.correlation_id,
      audit_reason = EXCLUDED.audit_reason,
      evidence_links = EXCLUDED.evidence_links,
      ticket_ref = EXCLUDED.ticket_ref,
      actor_session_id = EXCLUDED.actor_session_id,
      actor_wallet = EXCLUDED.actor_wallet,
      actor_role = EXCLUDED.actor_role,
      requested_by = EXCLUDED.requested_by,
      approved_by = EXCLUDED.approved_by,
      blocked_at = EXCLUDED.blocked_at,
      resumed_at = EXCLUDED.resumed_at,
      updated_at = EXCLUDED.updated_at`,
    [
      block.tradeId,
      block.latestDecisionId,
      block.blockState,
      block.reasonCode,
      block.requestId,
      block.correlationId,
      block.audit.reason,
      JSON.stringify(block.audit.evidenceLinks),
      block.audit.ticketRef,
      block.audit.actorSessionId,
      block.audit.actorWallet,
      block.audit.actorRole,
      block.audit.requestedBy,
      JSON.stringify(block.audit.approvedBy ?? []),
      block.blockedAt,
      block.resumedAt,
      block.updatedAt,
    ],
  );
}

async function runTransactionalWrite<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Compliance write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`);
    }

    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresComplianceWriteStore(
  pool: Pool,
  store: ComplianceStore,
): ComplianceWriteStore {
  return {
    async saveDecisionWithAudit(decision, auditEntry) {
      await runTransactionalWrite(pool, async (client) => {
        await insertComplianceDecision(client, decision);
        await insertAuditLog(client, auditEntry);
      });

      const stored = await store.getDecision(decision.decisionId);
      if (!stored) {
        throw new Error(`Failed to persist compliance decision ${decision.decisionId}`);
      }

      return stored;
    },

    async saveBlockStateWithAudit(block, auditEntry) {
      await runTransactionalWrite(pool, async (client) => {
        await upsertOracleProgressionBlock(client, block);
        await insertAuditLog(client, auditEntry);
      });

      const stored = await store.getOracleProgressionBlock(block.tradeId);
      if (!stored) {
        throw new Error(`Failed to persist oracle progression block state for trade ${block.tradeId}`);
      }

      return stored;
    },
  };
}

export function createPassthroughComplianceWriteStore(
  store: ComplianceStore,
  auditLogStore: AuditLogStore,
): ComplianceWriteStore {
  return {
    async saveDecisionWithAudit(decision, auditEntry) {
      const stored = await store.saveDecision(decision);
      await auditLogStore.append(auditEntry);
      return stored;
    },

    async saveBlockStateWithAudit(block, auditEntry) {
      const stored = await store.saveOracleProgressionBlock(block);
      await auditLogStore.append(auditEntry);
      return stored;
    },
  };
}
