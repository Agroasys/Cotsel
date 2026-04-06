/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';

export const GOVERNANCE_ACTION_CATEGORIES = [
  'pause',
  'unpause',
  'claims_pause',
  'claims_unpause',
  'treasury_sweep',
  'treasury_payout_receiver_update',
  'oracle_disable_emergency',
  'oracle_update',
] as const;

export const GOVERNANCE_ACTION_STATUSES = [
  // executor flow statuses
  'requested',
  'submitted',
  // direct_sign flow statuses
  'prepared',
  'broadcast_pending_verification',
  'broadcast',
  // shared post-execution statuses
  'pending_approvals',
  'approved',
  'executed',
  'cancelled',
  'expired',
  'stale',
  'failed',
] as const;

export const GOVERNANCE_FLOW_TYPES = ['executor', 'direct_sign'] as const;
export const GOVERNANCE_VERIFICATION_STATES = [
  'not_required',
  'not_started',
  'pending',
  'verified',
  'failed',
] as const;
export const GOVERNANCE_MONITORING_STATES = [
  'not_required',
  'not_started',
  'pending_verification',
  'pending_confirmation',
  'confirmed',
  'finalized',
  'reverted',
  'stale',
] as const;

export type GovernanceActionCategory = typeof GOVERNANCE_ACTION_CATEGORIES[number];
export type GovernanceActionStatus = typeof GOVERNANCE_ACTION_STATUSES[number];
export type GovernanceFlowType = typeof GOVERNANCE_FLOW_TYPES[number];
export type GovernanceVerificationState = typeof GOVERNANCE_VERIFICATION_STATES[number];
export type GovernanceMonitoringState = typeof GOVERNANCE_MONITORING_STATES[number];

export const GOVERNANCE_OPEN_INTENT_STATUSES: readonly GovernanceActionStatus[] = [
  'requested',
  'submitted',
  'prepared',
  'broadcast_pending_verification',
  'broadcast',
  'pending_approvals',
  'approved',
] as const;

export const GOVERNANCE_APPROVAL_CONTRACT_METHODS = [
  'approveUnpause',
  'approveTreasuryPayoutAddressUpdate',
  'approveOracleUpdate',
] as const;

// Governance records retain `extrinsicHash` only for archived Substrate-era
// actions. Active Base governance evidence uses `txHash`; new Base-originated
// actions should continue storing the legacy field as null.

export interface EvidenceLink {
  kind: 'runbook' | 'incident' | 'ticket' | 'tx' | 'event' | 'document' | 'log' | 'dashboard' | 'other';
  uri: string;
  note?: string;
}

export type GovernanceSigningArgValue = string | number | boolean;

export interface GovernancePreparedTransactionRequest {
  chainId: number;
  to: string;
  data: string;
  value: string;
}

export interface GovernancePreparedSigningPayload {
  chainId: number;
  contractAddress: string;
  contractMethod: string;
  args: GovernanceSigningArgValue[];
  txRequest: GovernancePreparedTransactionRequest;
  signerWallet: string;
  preparedPayloadHash: string;
}

export interface GovernanceActionAuditRecord {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorAccountId?: string | null;
  actorWallet: string;
  actorRole: string;
  createdAt: string;
  requestedBy: string;
  approvedBy?: string[];
  finalSignerWallet?: string | null;
  finalSignerVerifiedAt?: string | null;
}

export interface GovernanceActionRecord {
  actionId: string;
  intentKey: string;
  intentHash?: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  flowType: GovernanceFlowType;
  contractMethod: string;
  txHash: string | null;
  extrinsicHash: string | null;
  blockNumber: number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  broadcastAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  executedAt: string | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey?: string;
  actorId?: string;
  endpoint?: string;
  errorCode: string | null;
  errorMessage: string | null;
  audit: GovernanceActionAuditRecord;
  signing?: GovernancePreparedSigningPayload | null;
  finalSignerWallet?: string | null;
  verificationState?: GovernanceVerificationState;
  verificationError?: string | null;
  verifiedAt?: string | null;
  monitoringState?: GovernanceMonitoringState;
}

export interface ListGovernanceActionsInput {
  category?: GovernanceActionCategory;
  categories?: GovernanceActionCategory[];
  status?: GovernanceActionStatus;
  tradeId?: string;
  limit: number;
  cursor?: string;
}

export interface GovernanceActionCursor {
  createdAt: string;
  actionId: string;
}

export interface ListGovernanceActionsResult {
  items: GovernanceActionRecord[];
  nextCursor: string | null;
}

export interface GovernanceActionStore {
  save(action: GovernanceActionRecord): Promise<GovernanceActionRecord>;
  get(actionId: string): Promise<GovernanceActionRecord | null>;
  findOpenByIntentKey(intentKey: string, now: string): Promise<GovernanceActionRecord | null>;
  list(input: ListGovernanceActionsInput): Promise<ListGovernanceActionsResult>;
  listRequestedExpired(now: string, limit: number): Promise<GovernanceActionRecord[]>;
  listActiveProposalIds(category: GovernanceActionCategory): Promise<number[]>;
}

const ACTIVE_PROPOSAL_STATUSES: readonly GovernanceActionStatus[] = GOVERNANCE_OPEN_INTENT_STATUSES.filter((status) => status !== 'submitted');

interface GovernanceActionRow {
  actionId: string;
  intentKey: string | null;
  intentHash: string | null;
  proposalId: string | number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  flowType: GovernanceFlowType;
  contractMethod: string;
  txHash: string | null;
  extrinsicHash: string | null;
  blockNumber: string | number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  broadcastAt: Date | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey: string | null;
  actorId: string | null;
  endpoint: string | null;
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string;
  actorRole: string;
  requestedBy: string;
  approvedBy: string[] | null;
  actorAccountId: string | null;
  finalSignerWallet: string | null;
  verificationState: GovernanceVerificationState | null;
  verificationError: string | null;
  verifiedAt: Date | null;
  monitoringState: GovernanceMonitoringState | null;
  signing: GovernancePreparedSigningPayload | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  executedAt: Date | null;
}

function normalizeIntentFragment(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim().toLowerCase();
}

export function isApprovalGovernanceContractMethod(contractMethod: string): boolean {
  return (GOVERNANCE_APPROVAL_CONTRACT_METHODS as readonly string[]).includes(contractMethod);
}

export function buildGovernanceIntentKey(input: {
  category: GovernanceActionCategory;
  contractMethod: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  chainId?: string | number | null;
  approverWallet?: string | null;
}): string {
  return [
    'v1',
    normalizeIntentFragment(input.category),
    normalizeIntentFragment(input.contractMethod),
    normalizeIntentFragment(input.proposalId),
    normalizeIntentFragment(input.targetAddress),
    normalizeIntentFragment(input.tradeId),
    normalizeIntentFragment(input.chainId),
    normalizeIntentFragment(
      isApprovalGovernanceContractMethod(input.contractMethod)
        ? input.approverWallet ?? null
        : null,
    ),
  ].join('|');
}

export function isExpiredRequestedGovernanceAction(action: GovernanceActionRecord, now: string): boolean {
  return action.status === 'requested'
    && action.expiresAt !== null
    && action.expiresAt <= now;
}

function numericOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric governance field, received: ${String(value)}`);
  }

  return parsed;
}

function defaultVerificationState(row: Pick<GovernanceActionRow, 'flowType' | 'status'>): GovernanceVerificationState {
  if (row.flowType !== 'direct_sign') {
    return 'not_required';
  }

  switch (row.status) {
    case 'prepared':
      return 'not_started';
    case 'broadcast_pending_verification':
      return 'pending';
    case 'broadcast':
    case 'executed':
      return 'verified';
    case 'failed':
      return 'failed';
    default:
      return 'not_started';
  }
}

function defaultMonitoringState(row: Pick<GovernanceActionRow, 'flowType' | 'status'>): GovernanceMonitoringState {
  if (row.flowType !== 'direct_sign') {
    return 'not_required';
  }

  switch (row.status) {
    case 'prepared':
      return 'not_started';
    case 'broadcast_pending_verification':
      return 'pending_verification';
    case 'broadcast':
      return 'pending_confirmation';
    case 'executed':
      return 'finalized';
    case 'failed':
      return 'reverted';
    case 'stale':
      return 'stale';
    default:
      return 'not_started';
  }
}

function mapRow(row: GovernanceActionRow): GovernanceActionRecord {
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
    flowType: row.flowType ?? 'executor',
    contractMethod: row.contractMethod,
    txHash: row.txHash,
    extrinsicHash: row.extrinsicHash,
    blockNumber: numericOrNull(row.blockNumber),
    tradeId: row.tradeId,
    chainId: row.chainId,
    targetAddress: row.targetAddress,
    broadcastAt: row.broadcastAt ? row.broadcastAt.toISOString() : null,
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
    signing: row.signing ?? null,
    finalSignerWallet: row.finalSignerWallet,
    verificationState: row.verificationState ?? defaultVerificationState(row),
    verificationError: row.verificationError,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    monitoringState: row.monitoringState ?? defaultMonitoringState(row),
    audit: {
      reason: row.reason,
      evidenceLinks: row.evidenceLinks || [],
      ticketRef: row.ticketRef,
      actorSessionId: row.actorSessionId,
      ...(row.actorAccountId ? { actorAccountId: row.actorAccountId } : {}),
      actorWallet: row.actorWallet,
      actorRole: row.actorRole,
      createdAt: row.createdAt.toISOString(),
      requestedBy: row.requestedBy,
      ...(row.approvedBy && row.approvedBy.length > 0 ? { approvedBy: row.approvedBy } : {}),
      ...(row.finalSignerWallet ? { finalSignerWallet: row.finalSignerWallet } : {}),
      ...(row.verifiedAt ? { finalSignerVerifiedAt: row.verifiedAt.toISOString() } : {}),
    },
  };
}

export function encodeGovernanceActionCursor(cursor: GovernanceActionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeGovernanceActionCursor(cursor: string): GovernanceActionCursor {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as GovernanceActionCursor;
  if (!parsed.createdAt || !parsed.actionId) {
    throw new Error('Cursor is missing required fields');
  }

  if (Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error('Cursor createdAt must be an ISO timestamp');
  }

  return parsed;
}

function nextCursorFromItems(items: GovernanceActionRecord[], limit: number): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeGovernanceActionCursor({
    createdAt: boundary.createdAt,
    actionId: boundary.actionId,
  });
}

export function createPostgresGovernanceActionStore(pool: Pool): GovernanceActionStore {
  const selectColumns = `SELECT
    action_id AS "actionId",
    intent_key AS "intentKey",
    intent_hash AS "intentHash",
    proposal_id AS "proposalId",
    category,
    status,
    COALESCE(flow_type, 'executor') AS "flowType",
    contract_method AS "contractMethod",
    tx_hash AS "txHash",
    extrinsic_hash AS "extrinsicHash",
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
          extrinsic_hash,
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
          $23, $24, $25, $26, $27, $28::jsonb, $29, $30, $31, $32, $33, $34, $35,
          $36, $37, $38, $39::jsonb, $40, $41, $42, $43, $44, NOW()
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
          extrinsic_hash = EXCLUDED.extrinsic_hash,
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
          action.extrinsicHash,
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
          action.verificationState ?? (action.flowType === 'direct_sign' ? 'not_started' : 'not_required'),
          action.verificationError ?? null,
          action.verifiedAt ?? null,
          action.monitoringState ?? (action.flowType === 'direct_sign' ? 'not_started' : 'not_required'),
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

      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async findOpenByIntentKey(intentKey, now) {
      const result = await pool.query<GovernanceActionRow>(
        `${selectColumns}
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

      return result.rows[0] ? mapRow(result.rows[0]) : null;
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
        conditions.push(`(created_at < $${createdAtIndex}::timestamp OR (created_at = $${createdAtIndex}::timestamp AND action_id < $${actionIdIndex}))`);
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

      const mapped = result.rows.map(mapRow);
      return {
        items: mapped.slice(0, input.limit),
        nextCursor: nextCursorFromItems(mapped, input.limit),
      };
    },

    async listRequestedExpired(now, limit) {
      const result = await pool.query<GovernanceActionRow>(
        `${selectColumns}
         FROM governance_actions
         WHERE status = 'requested'
           AND expires_at IS NOT NULL
           AND expires_at <= $1::timestamp
         ORDER BY expires_at ASC, action_id ASC
         LIMIT $2`,
        [now, limit],
      );

      return result.rows.map(mapRow);
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

export function createInMemoryGovernanceActionStore(initial: GovernanceActionRecord[] = []): GovernanceActionStore {
  const items = new Map<string, GovernanceActionRecord>(initial.map((action) => [action.actionId, action]));

  function sorted(): GovernanceActionRecord[] {
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
      return (await this.get(action.actionId))!;
    },

    async get(actionId) {
      const action = items.get(actionId);
      return action ? { ...action, audit: { ...action.audit, evidenceLinks: [...action.audit.evidenceLinks], ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}) } } : null;
    },

    async findOpenByIntentKey(intentKey, now) {
      const action = sorted().find((candidate) => (
        candidate.intentKey === intentKey
        && GOVERNANCE_OPEN_INTENT_STATUSES.includes(candidate.status)
        && !isExpiredRequestedGovernanceAction(candidate, now)
        && !(candidate.status === 'prepared' && candidate.expiresAt !== null && candidate.expiresAt <= now)
      ));

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
        candidates = candidates.filter((action) => (
          action.createdAt < cursor.createdAt
          || (action.createdAt === cursor.createdAt && action.actionId < cursor.actionId)
        ));
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
      const seen = new Set<number>();
      for (const action of sorted()) {
        if (
          action.category !== category ||
          action.proposalId === null ||
          !ACTIVE_PROPOSAL_STATUSES.includes(action.status)
        ) {
          continue;
        }
        seen.add(action.proposalId);
      }

      return [...seen].sort((left, right) => left - right);
    },
  };
}
