"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPostgresGovernanceWriteStore = createPostgresGovernanceWriteStore;
exports.createPassthroughGovernanceWriteStore = createPassthroughGovernanceWriteStore;
function governanceActionParams(action) {
    return [
        action.actionId,
        action.intentKey,
        action.intentHash ?? null,
        action.proposalId,
        action.category,
        action.status,
        action.contractMethod,
        action.txHash,
        action.extrinsicHash,
        action.blockNumber,
        action.tradeId,
        action.chainId,
        action.targetAddress,
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
        action.errorCode,
        action.errorMessage,
        action.createdAt,
        action.expiresAt,
        action.executedAt,
    ];
}
async function upsertGovernanceAction(client, action) {
    await client.query(`INSERT INTO governance_actions (
      action_id,
      intent_key,
      intent_hash,
      proposal_id,
      category,
      status,
      contract_method,
      tx_hash,
      extrinsic_hash,
      block_number,
      trade_id,
      chain_id,
      target_address,
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
      error_code,
      error_message,
      created_at,
      expires_at,
      executed_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23, $24,
      $25, $26::jsonb, $27, $28, $29, $30, $31, NOW()
    )
    ON CONFLICT (action_id) DO UPDATE SET
      intent_key = EXCLUDED.intent_key,
      intent_hash = EXCLUDED.intent_hash,
      proposal_id = EXCLUDED.proposal_id,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      contract_method = EXCLUDED.contract_method,
      tx_hash = EXCLUDED.tx_hash,
      extrinsic_hash = EXCLUDED.extrinsic_hash,
      block_number = EXCLUDED.block_number,
      trade_id = EXCLUDED.trade_id,
      chain_id = EXCLUDED.chain_id,
      target_address = EXCLUDED.target_address,
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
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at,
      executed_at = EXCLUDED.executed_at,
      updated_at = NOW()`, governanceActionParams(action));
}
async function insertAuditLog(client, entry) {
    await client.query(`INSERT INTO audit_log (
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
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`, [
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
    ]);
}
function createPostgresGovernanceWriteStore(pool, readStore) {
    async function loadExistingOpenIntentAction(client, intentKey, now) {
        const result = await client.query(`SELECT action_id AS "actionId"
       FROM governance_actions
       WHERE intent_key = $1
         AND status = ANY($2::text[])
         AND (
           status <> 'requested'
           OR expires_at IS NULL
           OR expires_at > $3::timestamp
         )
       ORDER BY created_at DESC, action_id DESC
       LIMIT 1`, [intentKey, ['requested', 'submitted', 'pending_approvals', 'approved'], now]);
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
            }
            catch (error) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (rollbackError) {
                    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    const originalMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`Governance write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`);
                }
                throw error;
            }
            finally {
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
            let existingActionId = null;
            let created = false;
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [action.intentKey]);
                const existing = await loadExistingOpenIntentAction(client, action.intentKey, now);
                if (existing) {
                    existingActionId = existing.actionId;
                    const storedExisting = await readStore.get(existing.actionId);
                    if (!storedExisting) {
                        throw new Error(`Failed to load governance action ${existing.actionId} for semantic dedupe`);
                    }
                    await insertAuditLog(client, duplicateAuditEntry(storedExisting));
                }
                else {
                    await upsertGovernanceAction(client, action);
                    await insertAuditLog(client, auditEntry);
                    created = true;
                    existingActionId = action.actionId;
                }
                await client.query('COMMIT');
            }
            catch (error) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (rollbackError) {
                    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    const originalMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`Governance write rollback failed after original error: ${originalMessage}; rollback error: ${rollbackMessage}`);
                }
                throw error;
            }
            finally {
                client.release();
            }
            const stored = existingActionId ? await readStore.get(existingActionId) : null;
            if (!stored) {
                throw new Error(`Failed to persist governance action ${existingActionId ?? action.actionId}`);
            }
            return {
                action: stored,
                created,
            };
        },
    };
}
function createPassthroughGovernanceWriteStore(actionStore, auditLogStore) {
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
    };
}
//# sourceMappingURL=governanceWriteStore.js.map