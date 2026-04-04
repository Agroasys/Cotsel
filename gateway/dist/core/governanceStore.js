"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOVERNANCE_APPROVAL_CONTRACT_METHODS = exports.GOVERNANCE_OPEN_INTENT_STATUSES = exports.GOVERNANCE_ACTION_STATUSES = exports.GOVERNANCE_ACTION_CATEGORIES = void 0;
exports.isApprovalGovernanceContractMethod = isApprovalGovernanceContractMethod;
exports.buildGovernanceIntentKey = buildGovernanceIntentKey;
exports.isExpiredRequestedGovernanceAction = isExpiredRequestedGovernanceAction;
exports.encodeGovernanceActionCursor = encodeGovernanceActionCursor;
exports.decodeGovernanceActionCursor = decodeGovernanceActionCursor;
exports.createPostgresGovernanceActionStore = createPostgresGovernanceActionStore;
exports.createInMemoryGovernanceActionStore = createInMemoryGovernanceActionStore;
exports.GOVERNANCE_ACTION_CATEGORIES = [
    'pause',
    'unpause',
    'claims_pause',
    'claims_unpause',
    'treasury_sweep',
    'treasury_payout_receiver_update',
    'oracle_disable_emergency',
    'oracle_update',
];
exports.GOVERNANCE_ACTION_STATUSES = [
    'requested',
    'submitted',
    'pending_approvals',
    'approved',
    'executed',
    'cancelled',
    'expired',
    'stale',
    'failed',
];
exports.GOVERNANCE_OPEN_INTENT_STATUSES = [
    'requested',
    'submitted',
    'pending_approvals',
    'approved',
];
exports.GOVERNANCE_APPROVAL_CONTRACT_METHODS = [
    'approveUnpause',
    'approveTreasuryPayoutAddressUpdate',
    'approveOracleUpdate',
];
const ACTIVE_PROPOSAL_STATUSES = exports.GOVERNANCE_OPEN_INTENT_STATUSES.filter((status) => status !== 'submitted');
function normalizeIntentFragment(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim().toLowerCase();
}
function isApprovalGovernanceContractMethod(contractMethod) {
    return exports.GOVERNANCE_APPROVAL_CONTRACT_METHODS.includes(contractMethod);
}
function buildGovernanceIntentKey(input) {
    return [
        'v1',
        normalizeIntentFragment(input.category),
        normalizeIntentFragment(input.contractMethod),
        normalizeIntentFragment(input.proposalId),
        normalizeIntentFragment(input.targetAddress),
        normalizeIntentFragment(input.tradeId),
        normalizeIntentFragment(input.chainId),
        normalizeIntentFragment(isApprovalGovernanceContractMethod(input.contractMethod)
            ? input.approverWallet ?? null
            : null),
    ].join('|');
}
function isExpiredRequestedGovernanceAction(action, now) {
    return action.status === 'requested'
        && action.expiresAt !== null
        && action.expiresAt <= now;
}
function numericOrNull(value) {
    if (value === null) {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Expected numeric governance field, received: ${String(value)}`);
    }
    return parsed;
}
function mapRow(row) {
    return {
        actionId: row.actionId,
        intentKey: row.intentKey ?? buildGovernanceIntentKey({
            category: row.category,
            contractMethod: row.contractMethod,
            proposalId: numericOrNull(row.proposalId),
            targetAddress: row.targetAddress,
            tradeId: row.tradeId,
            chainId: row.chainId,
            approverWallet: row.actorWallet,
        }),
        intentHash: row.intentHash ?? undefined,
        proposalId: numericOrNull(row.proposalId),
        category: row.category,
        status: row.status,
        contractMethod: row.contractMethod,
        txHash: row.txHash,
        extrinsicHash: row.extrinsicHash,
        blockNumber: numericOrNull(row.blockNumber),
        tradeId: row.tradeId,
        chainId: row.chainId,
        targetAddress: row.targetAddress,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        executedAt: row.executedAt ? row.executedAt.toISOString() : null,
        requestId: row.requestId,
        correlationId: row.correlationId,
        idempotencyKey: row.idempotencyKey ?? undefined,
        actorId: row.actorId ?? undefined,
        endpoint: row.endpoint ?? undefined,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        audit: {
            reason: row.reason,
            evidenceLinks: row.evidenceLinks || [],
            ticketRef: row.ticketRef,
            actorSessionId: row.actorSessionId,
            actorWallet: row.actorWallet,
            actorRole: row.actorRole,
            createdAt: row.createdAt.toISOString(),
            requestedBy: row.requestedBy,
            ...(row.approvedBy && row.approvedBy.length > 0 ? { approvedBy: row.approvedBy } : {}),
        },
    };
}
function encodeGovernanceActionCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeGovernanceActionCursor(cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed.createdAt || !parsed.actionId) {
        throw new Error('Cursor is missing required fields');
    }
    if (Number.isNaN(Date.parse(parsed.createdAt))) {
        throw new Error('Cursor createdAt must be an ISO timestamp');
    }
    return parsed;
}
function nextCursorFromItems(items, limit) {
    if (items.length <= limit) {
        return null;
    }
    const boundary = items[limit - 1];
    return encodeGovernanceActionCursor({
        createdAt: boundary.createdAt,
        actionId: boundary.actionId,
    });
}
function createPostgresGovernanceActionStore(pool) {
    const selectColumns = `SELECT
    action_id AS "actionId",
    intent_key AS "intentKey",
    intent_hash AS "intentHash",
    proposal_id AS "proposalId",
    category,
    status,
    contract_method AS "contractMethod",
    tx_hash AS "txHash",
    extrinsic_hash AS "extrinsicHash",
    block_number AS "blockNumber",
    trade_id AS "tradeId",
    chain_id AS "chainId",
    target_address AS "targetAddress",
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
    error_code AS "errorCode",
    error_message AS "errorMessage",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    executed_at AS "executedAt"`;
    return {
        async save(action) {
            await pool.query(`INSERT INTO governance_actions (
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
          updated_at = NOW()`, [
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
            ]);
            const stored = await this.get(action.actionId);
            if (!stored) {
                throw new Error(`Failed to persist governance action ${action.actionId}`);
            }
            return stored;
        },
        async get(actionId) {
            const result = await pool.query(`${selectColumns}
         FROM governance_actions
         WHERE action_id = $1`, [actionId]);
            return result.rows[0] ? mapRow(result.rows[0]) : null;
        },
        async findOpenByIntentKey(intentKey, now) {
            const result = await pool.query(`${selectColumns}
         FROM governance_actions
         WHERE intent_key = $1
           AND status = ANY($2::text[])
           AND (
             status <> 'requested'
             OR expires_at IS NULL
             OR expires_at > $3::timestamp
           )
         ORDER BY created_at DESC, action_id DESC
         LIMIT 1`, [intentKey, exports.GOVERNANCE_OPEN_INTENT_STATUSES, now]);
            return result.rows[0] ? mapRow(result.rows[0]) : null;
        },
        async list(input) {
            const values = [];
            const conditions = [];
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
                conditions.push(`(created_at < $${createdAtIndex}::timestamp OR (created_at = $${createdAtIndex}::timestamp AND action_id < $${actionIdIndex}))`);
            }
            values.push(input.limit + 1);
            const limitIndex = values.length;
            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const result = await pool.query(`${selectColumns}
         FROM governance_actions
         ${whereClause}
         ORDER BY created_at DESC, action_id DESC
         LIMIT $${limitIndex}`, values);
            const mapped = result.rows.map(mapRow);
            return {
                items: mapped.slice(0, input.limit),
                nextCursor: nextCursorFromItems(mapped, input.limit),
            };
        },
        async listRequestedExpired(now, limit) {
            const result = await pool.query(`${selectColumns}
         FROM governance_actions
         WHERE status = 'requested'
           AND expires_at IS NOT NULL
           AND expires_at <= $1::timestamp
         ORDER BY expires_at ASC, action_id ASC
         LIMIT $2`, [now, limit]);
            return result.rows.map(mapRow);
        },
        async listActiveProposalIds(category) {
            const result = await pool.query(`SELECT DISTINCT proposal_id AS "proposalId"
         FROM governance_actions
         WHERE category = $1
           AND proposal_id IS NOT NULL
           AND status = ANY($2::text[])
         ORDER BY proposal_id ASC`, [category, ACTIVE_PROPOSAL_STATUSES]);
            return result.rows
                .map((row) => numericOrNull(row.proposalId))
                .filter((value) => value !== null);
        },
    };
}
function createInMemoryGovernanceActionStore(initial = []) {
    const items = new Map(initial.map((action) => [action.actionId, action]));
    function sorted() {
        return [...items.values()].sort((left, right) => {
            if (left.createdAt === right.createdAt) {
                return right.actionId.localeCompare(left.actionId);
            }
            return right.createdAt.localeCompare(left.createdAt);
        });
    }
    return {
        async save(action) {
            items.set(action.actionId, { ...action, audit: { ...action.audit, evidenceLinks: [...action.audit.evidenceLinks], ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}) } });
            return (await this.get(action.actionId));
        },
        async get(actionId) {
            const action = items.get(actionId);
            return action ? { ...action, audit: { ...action.audit, evidenceLinks: [...action.audit.evidenceLinks], ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}) } } : null;
        },
        async findOpenByIntentKey(intentKey, now) {
            const action = sorted().find((candidate) => (candidate.intentKey === intentKey
                && exports.GOVERNANCE_OPEN_INTENT_STATUSES.includes(candidate.status)
                && !isExpiredRequestedGovernanceAction(candidate, now)));
            return action ? { ...action, audit: { ...action.audit, evidenceLinks: [...action.audit.evidenceLinks], ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}) } } : null;
        },
        async list(input) {
            let candidates = sorted();
            if (input.category) {
                candidates = candidates.filter((action) => action.category === input.category);
            }
            if (input.categories && input.categories.length > 0) {
                candidates = candidates.filter((action) => input.categories?.includes(action.category));
            }
            if (input.status) {
                candidates = candidates.filter((action) => action.status === input.status);
            }
            if (input.tradeId) {
                candidates = candidates.filter((action) => action.tradeId === input.tradeId);
            }
            if (input.cursor) {
                const cursor = decodeGovernanceActionCursor(input.cursor);
                candidates = candidates.filter((action) => (action.createdAt < cursor.createdAt
                    || (action.createdAt === cursor.createdAt && action.actionId < cursor.actionId)));
            }
            const page = candidates.slice(0, input.limit + 1);
            return {
                items: page.slice(0, input.limit),
                nextCursor: nextCursorFromItems(page, input.limit),
            };
        },
        async listRequestedExpired(now, limit) {
            return sorted()
                .filter((action) => isExpiredRequestedGovernanceAction(action, now))
                .slice(0, limit)
                .map((action) => ({
                ...action,
                audit: {
                    ...action.audit,
                    evidenceLinks: [...action.audit.evidenceLinks],
                    ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}),
                },
            }));
        },
        async listActiveProposalIds(category) {
            const seen = new Set();
            for (const action of sorted()) {
                if (action.category !== category ||
                    action.proposalId === null ||
                    !ACTIVE_PROPOSAL_STATUSES.includes(action.status)) {
                    continue;
                }
                seen.add(action.proposalId);
            }
            return [...seen].sort((left, right) => left - right);
        },
    };
}
//# sourceMappingURL=governanceStore.js.map