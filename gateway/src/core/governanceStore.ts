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
  'requested',
  'pending_approvals',
  'approved',
  'executed',
  'cancelled',
  'expired',
  'failed',
] as const;

export type GovernanceActionCategory = typeof GOVERNANCE_ACTION_CATEGORIES[number];
export type GovernanceActionStatus = typeof GOVERNANCE_ACTION_STATUSES[number];

export interface EvidenceLink {
  kind: 'runbook' | 'incident' | 'ticket' | 'tx' | 'event' | 'document' | 'log' | 'dashboard' | 'other';
  uri: string;
  note?: string;
}

export interface GovernanceActionAuditRecord {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string;
  actorRole: string;
  createdAt: string;
  requestedBy: string;
  approvedBy?: string[];
}

export interface GovernanceActionRecord {
  actionId: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  contractMethod: string;
  txHash: string | null;
  extrinsicHash: string | null;
  blockNumber: number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  createdAt: string;
  executedAt: string | null;
  requestId: string;
  correlationId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  audit: GovernanceActionAuditRecord;
}

export interface ListGovernanceActionsInput {
  category?: GovernanceActionCategory;
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
  list(input: ListGovernanceActionsInput): Promise<ListGovernanceActionsResult>;
  listActiveProposalIds(category: GovernanceActionCategory): Promise<number[]>;
}

const ACTIVE_PROPOSAL_STATUSES: readonly GovernanceActionStatus[] = [
  'requested',
  'pending_approvals',
  'approved',
];

interface GovernanceActionRow {
  actionId: string;
  proposalId: string | number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  contractMethod: string;
  txHash: string | null;
  extrinsicHash: string | null;
  blockNumber: string | number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  requestId: string;
  correlationId: string | null;
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string;
  actorRole: string;
  requestedBy: string;
  approvedBy: string[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  executedAt: Date | null;
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

function mapRow(row: GovernanceActionRow): GovernanceActionRecord {
  return {
    actionId: row.actionId,
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
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    requestId: row.requestId,
    correlationId: row.correlationId,
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
    executed_at AS "executedAt"`;

  return {
    async save(action) {
      await pool.query(
        `INSERT INTO governance_actions (
          action_id,
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
          executed_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20,
          $21::jsonb, $22, $23, $24, $25, NOW()
        )
        ON CONFLICT (action_id) DO UPDATE SET
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
          executed_at = EXCLUDED.executed_at,
          updated_at = NOW()`,
        [
          action.actionId,
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

    async list(input) {
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (input.category) {
        values.push(input.category);
        conditions.push(`category = $${values.length}`);
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

    async list(input) {
      let candidates = sorted();

      if (input.category) {
        candidates = candidates.filter((action) => action.category === input.category);
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
