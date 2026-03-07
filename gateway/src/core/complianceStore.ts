/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { EvidenceLink } from './governanceStore';

export const COMPLIANCE_DECISION_TYPES = ['KYB', 'KYT', 'SANCTIONS'] as const;
export const COMPLIANCE_DECISION_RESULTS = ['ALLOW', 'DENY'] as const;
export const COMPLIANCE_BLOCK_STATES = ['not_blocked', 'blocked', 'resume_pending'] as const;
export const COMPLIANCE_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export type ComplianceDecisionType = typeof COMPLIANCE_DECISION_TYPES[number];
export type ComplianceDecisionResult = typeof COMPLIANCE_DECISION_RESULTS[number];
export type ComplianceBlockState = typeof COMPLIANCE_BLOCK_STATES[number];
export type ComplianceRiskLevel = typeof COMPLIANCE_RISK_LEVELS[number];

export interface ComplianceAuditRecord {
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

export interface ComplianceDecisionRecord {
  decisionId: string;
  tradeId: string;
  decisionType: ComplianceDecisionType;
  result: ComplianceDecisionResult;
  reasonCode: string;
  provider: string;
  providerRef: string;
  subjectId: string;
  subjectType: string;
  riskLevel: ComplianceRiskLevel | null;
  correlationId: string;
  decidedAt: string;
  overrideWindowEndsAt: string | null;
  blockState: ComplianceBlockState;
  audit: ComplianceAuditRecord;
}

export interface OracleProgressionBlockRecord {
  tradeId: string;
  latestDecisionId: string;
  blockState: ComplianceBlockState;
  reasonCode: string;
  requestId: string;
  correlationId: string | null;
  audit: ComplianceAuditRecord;
  blockedAt: string | null;
  resumedAt: string | null;
  updatedAt: string;
}

export interface ComplianceTradeStatusRecord {
  tradeId: string;
  currentResult: ComplianceDecisionResult;
  oracleProgressionBlocked: boolean;
  blockState: ComplianceBlockState;
  latestDecisionId: string;
  latestReasonCode?: string;
  latestProvider?: string;
  latestCorrelationId?: string;
  updatedAt: string;
}

export interface ListComplianceDecisionsInput {
  tradeId: string;
  limit: number;
  cursor?: string;
}

export interface ComplianceDecisionCursor {
  decidedAt: string;
  decisionId: string;
}

export interface ListComplianceDecisionsResult {
  items: ComplianceDecisionRecord[];
  nextCursor: string | null;
}

export interface ComplianceStore {
  saveDecision(decision: ComplianceDecisionRecord): Promise<ComplianceDecisionRecord>;
  getDecision(decisionId: string): Promise<ComplianceDecisionRecord | null>;
  getLatestDecision(tradeId: string): Promise<ComplianceDecisionRecord | null>;
  listTradeDecisions(input: ListComplianceDecisionsInput): Promise<ListComplianceDecisionsResult>;
  saveOracleProgressionBlock(block: OracleProgressionBlockRecord): Promise<OracleProgressionBlockRecord>;
  getOracleProgressionBlock(tradeId: string): Promise<OracleProgressionBlockRecord | null>;
  getTradeStatus(tradeId: string): Promise<ComplianceTradeStatusRecord | null>;
}

interface ComplianceDecisionRow {
  decisionId: string;
  tradeId: string;
  decisionType: ComplianceDecisionType;
  result: ComplianceDecisionResult;
  reasonCode: string;
  provider: string;
  providerRef: string;
  subjectId: string;
  subjectType: string;
  riskLevel: ComplianceRiskLevel | null;
  correlationId: string;
  decidedAt: Date;
  overrideWindowEndsAt: Date | null;
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string;
  actorRole: string;
  requestedBy: string;
  approvedBy: string[] | null;
}

interface OracleProgressionBlockRow {
  tradeId: string;
  latestDecisionId: string;
  blockState: ComplianceBlockState;
  reasonCode: string;
  requestId: string;
  correlationId: string | null;
  auditReason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string;
  actorRole: string;
  requestedBy: string;
  approvedBy: string[] | null;
  blockedAt: Date | null;
  resumedAt: Date | null;
  updatedAt: Date;
}

function cloneEvidenceLinks(links: EvidenceLink[]): EvidenceLink[] {
  return links.map((link) => ({
    kind: link.kind,
    uri: link.uri,
    ...(link.note ? { note: link.note } : {}),
  }));
}

function cloneAuditRecord(audit: ComplianceAuditRecord): ComplianceAuditRecord {
  return {
    ...audit,
    evidenceLinks: cloneEvidenceLinks(audit.evidenceLinks),
    ...(audit.approvedBy ? { approvedBy: [...audit.approvedBy] } : {}),
  };
}

function cloneDecisionRecord(decision: ComplianceDecisionRecord): ComplianceDecisionRecord {
  return {
    ...decision,
    audit: cloneAuditRecord(decision.audit),
  };
}

function cloneBlockRecord(block: OracleProgressionBlockRecord): OracleProgressionBlockRecord {
  return {
    ...block,
    audit: cloneAuditRecord(block.audit),
  };
}

function mapDecisionRow(row: ComplianceDecisionRow, blockState: ComplianceBlockState): ComplianceDecisionRecord {
  return {
    decisionId: row.decisionId,
    tradeId: row.tradeId,
    decisionType: row.decisionType,
    result: row.result,
    reasonCode: row.reasonCode,
    provider: row.provider,
    providerRef: row.providerRef,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    riskLevel: row.riskLevel,
    correlationId: row.correlationId,
    decidedAt: row.decidedAt.toISOString(),
    overrideWindowEndsAt: row.overrideWindowEndsAt ? row.overrideWindowEndsAt.toISOString() : null,
    blockState,
    audit: {
      reason: row.reason,
      evidenceLinks: row.evidenceLinks || [],
      ticketRef: row.ticketRef,
      actorSessionId: row.actorSessionId,
      actorWallet: row.actorWallet,
      actorRole: row.actorRole,
      createdAt: row.decidedAt.toISOString(),
      requestedBy: row.requestedBy,
      ...(row.approvedBy && row.approvedBy.length > 0 ? { approvedBy: row.approvedBy } : {}),
    },
  };
}

function mapBlockRow(row: OracleProgressionBlockRow): OracleProgressionBlockRecord {
  return {
    tradeId: row.tradeId,
    latestDecisionId: row.latestDecisionId,
    blockState: row.blockState,
    reasonCode: row.reasonCode,
    requestId: row.requestId,
    correlationId: row.correlationId,
    audit: {
      reason: row.auditReason,
      evidenceLinks: row.evidenceLinks || [],
      ticketRef: row.ticketRef,
      actorSessionId: row.actorSessionId,
      actorWallet: row.actorWallet,
      actorRole: row.actorRole,
      createdAt: row.updatedAt.toISOString(),
      requestedBy: row.requestedBy,
      ...(row.approvedBy && row.approvedBy.length > 0 ? { approvedBy: row.approvedBy } : {}),
    },
    blockedAt: row.blockedAt ? row.blockedAt.toISOString() : null,
    resumedAt: row.resumedAt ? row.resumedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function encodeComplianceDecisionCursor(cursor: ComplianceDecisionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeComplianceDecisionCursor(cursor: string): ComplianceDecisionCursor {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ComplianceDecisionCursor;
  if (!parsed.decidedAt || !parsed.decisionId) {
    throw new Error('Cursor is missing required fields');
  }

  if (Number.isNaN(Date.parse(parsed.decidedAt))) {
    throw new Error('Cursor decidedAt must be an ISO timestamp');
  }

  return parsed;
}

function nextCursorFromItems(items: ComplianceDecisionRecord[], limit: number): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeComplianceDecisionCursor({
    decidedAt: boundary.decidedAt,
    decisionId: boundary.decisionId,
  });
}

function blockedFlag(state: ComplianceBlockState): boolean {
  return state === 'blocked' || state === 'resume_pending';
}

async function loadBlockState(pool: Pool, tradeId: string): Promise<OracleProgressionBlockRecord | null> {
  const result = await pool.query<OracleProgressionBlockRow>(
    `SELECT
       trade_id AS "tradeId",
       latest_decision_id AS "latestDecisionId",
       block_state AS "blockState",
       reason_code AS "reasonCode",
       request_id AS "requestId",
       correlation_id AS "correlationId",
       audit_reason AS "auditReason",
       evidence_links AS "evidenceLinks",
       ticket_ref AS "ticketRef",
       actor_session_id AS "actorSessionId",
       actor_wallet AS "actorWallet",
       actor_role AS "actorRole",
       requested_by AS "requestedBy",
       approved_by AS "approvedBy",
       blocked_at AS "blockedAt",
       resumed_at AS "resumedAt",
       updated_at AS "updatedAt"
     FROM oracle_progression_blocks
     WHERE trade_id = $1`,
    [tradeId],
  );

  return result.rows[0] ? mapBlockRow(result.rows[0]) : null;
}

export function createPostgresComplianceStore(pool: Pool): ComplianceStore {
  const selectDecisionColumns = `SELECT
    decision_id AS "decisionId",
    trade_id AS "tradeId",
    decision_type AS "decisionType",
    result,
    reason_code AS "reasonCode",
    provider,
    provider_ref AS "providerRef",
    subject_id AS "subjectId",
    subject_type AS "subjectType",
    risk_level AS "riskLevel",
    correlation_id AS "correlationId",
    decided_at AS "decidedAt",
    override_window_ends_at AS "overrideWindowEndsAt",
    reason,
    evidence_links AS "evidenceLinks",
    ticket_ref AS "ticketRef",
    actor_session_id AS "actorSessionId",
    actor_wallet AS "actorWallet",
    actor_role AS "actorRole",
    requested_by AS "requestedBy",
    approved_by AS "approvedBy"`;

  return {
    async saveDecision(decision) {
      await pool.query(
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

      const stored = await this.getDecision(decision.decisionId);
      if (!stored) {
        throw new Error(`Failed to persist compliance decision ${decision.decisionId}`);
      }

      return stored;
    },

    async getDecision(decisionId) {
      const result = await pool.query<ComplianceDecisionRow>(
        `${selectDecisionColumns}
         FROM compliance_decisions
         WHERE decision_id = $1`,
        [decisionId],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const block = await loadBlockState(pool, row.tradeId);
      return mapDecisionRow(row, block?.blockState ?? 'not_blocked');
    },

    async getLatestDecision(tradeId) {
      const result = await pool.query<ComplianceDecisionRow>(
        `${selectDecisionColumns}
         FROM compliance_decisions
         WHERE trade_id = $1
         ORDER BY decided_at DESC, decision_id DESC
         LIMIT 1`,
        [tradeId],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const block = await loadBlockState(pool, tradeId);
      return mapDecisionRow(row, block?.blockState ?? 'not_blocked');
    },

    async listTradeDecisions(input) {
      const values: unknown[] = [input.tradeId];
      const conditions = ['trade_id = $1'];

      if (input.cursor) {
        const cursor = decodeComplianceDecisionCursor(input.cursor);
        values.push(cursor.decidedAt);
        const decidedAtIndex = values.length;
        values.push(cursor.decisionId);
        const decisionIdIndex = values.length;
        conditions.push(`(decided_at < $${decidedAtIndex}::timestamp OR (decided_at = $${decidedAtIndex}::timestamp AND decision_id < $${decisionIdIndex}))`);
      }

      values.push(input.limit + 1);
      const limitIndex = values.length;

      const result = await pool.query<ComplianceDecisionRow>(
        `${selectDecisionColumns}
         FROM compliance_decisions
         WHERE ${conditions.join(' AND ')}
         ORDER BY decided_at DESC, decision_id DESC
         LIMIT $${limitIndex}`,
        values,
      );

      const block = await loadBlockState(pool, input.tradeId);
      const mapped = result.rows.map((row) => mapDecisionRow(row, block?.blockState ?? 'not_blocked'));
      return {
        items: mapped.slice(0, input.limit),
        nextCursor: nextCursorFromItems(mapped, input.limit),
      };
    },

    async saveOracleProgressionBlock(block) {
      await pool.query(
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

      const stored = await this.getOracleProgressionBlock(block.tradeId);
      if (!stored) {
        throw new Error(`Failed to persist oracle progression block state for trade ${block.tradeId}`);
      }

      return stored;
    },

    async getOracleProgressionBlock(tradeId) {
      return loadBlockState(pool, tradeId);
    },

    async getTradeStatus(tradeId) {
      const latestDecision = await this.getLatestDecision(tradeId);
      if (!latestDecision) {
        return null;
      }

      const block = await this.getOracleProgressionBlock(tradeId);
      const blockState = block?.blockState ?? 'not_blocked';
      const updatedAt = block
        ? (block.updatedAt > latestDecision.decidedAt ? block.updatedAt : latestDecision.decidedAt)
        : latestDecision.decidedAt;

      return {
        tradeId,
        currentResult: latestDecision.result,
        oracleProgressionBlocked: blockedFlag(blockState),
        blockState,
        latestDecisionId: latestDecision.decisionId,
        latestReasonCode: latestDecision.reasonCode,
        latestProvider: latestDecision.provider,
        latestCorrelationId: latestDecision.correlationId,
        updatedAt,
      };
    },
  };
}

export function createInMemoryComplianceStore(
  initialDecisions: ComplianceDecisionRecord[] = [],
  initialBlocks: OracleProgressionBlockRecord[] = [],
): ComplianceStore {
  const decisions = new Map<string, ComplianceDecisionRecord>(
    initialDecisions.map((decision) => [decision.decisionId, cloneDecisionRecord(decision)]),
  );
  const blocks = new Map<string, OracleProgressionBlockRecord>(
    initialBlocks.map((block) => [block.tradeId, cloneBlockRecord(block)]),
  );

  function sortedTradeDecisions(tradeId: string): ComplianceDecisionRecord[] {
    return [...decisions.values()]
      .filter((decision) => decision.tradeId === tradeId)
      .sort((left, right) => {
        if (left.decidedAt === right.decidedAt) {
          return right.decisionId.localeCompare(left.decisionId);
        }

        return right.decidedAt.localeCompare(left.decidedAt);
      });
  }

  return {
    async saveDecision(decision) {
      decisions.set(decision.decisionId, cloneDecisionRecord(decision));
      return (await this.getDecision(decision.decisionId))!;
    },

    async getDecision(decisionId) {
      const decision = decisions.get(decisionId);
      if (!decision) {
        return null;
      }

      const blockState = blocks.get(decision.tradeId)?.blockState ?? 'not_blocked';
      return {
        ...cloneDecisionRecord(decision),
        blockState,
      };
    },

    async getLatestDecision(tradeId) {
      const latest = sortedTradeDecisions(tradeId)[0];
      if (!latest) {
        return null;
      }

      const blockState = blocks.get(tradeId)?.blockState ?? 'not_blocked';
      return {
        ...cloneDecisionRecord(latest),
        blockState,
      };
    },

    async listTradeDecisions(input) {
      let candidates = sortedTradeDecisions(input.tradeId);

      if (input.cursor) {
        const cursor = decodeComplianceDecisionCursor(input.cursor);
        candidates = candidates.filter((decision) => (
          decision.decidedAt < cursor.decidedAt
          || (decision.decidedAt === cursor.decidedAt && decision.decisionId < cursor.decisionId)
        ));
      }

      const blockState = blocks.get(input.tradeId)?.blockState ?? 'not_blocked';
      const page = candidates
        .map((decision) => ({ ...cloneDecisionRecord(decision), blockState }))
        .slice(0, input.limit + 1);

      return {
        items: page.slice(0, input.limit),
        nextCursor: nextCursorFromItems(page, input.limit),
      };
    },

    async saveOracleProgressionBlock(block) {
      blocks.set(block.tradeId, cloneBlockRecord(block));
      return (await this.getOracleProgressionBlock(block.tradeId))!;
    },

    async getOracleProgressionBlock(tradeId) {
      const block = blocks.get(tradeId);
      return block ? cloneBlockRecord(block) : null;
    },

    async getTradeStatus(tradeId) {
      const latestDecision = await this.getLatestDecision(tradeId);
      if (!latestDecision) {
        return null;
      }

      const block = await this.getOracleProgressionBlock(tradeId);
      const blockState = block?.blockState ?? 'not_blocked';
      const updatedAt = block
        ? (block.updatedAt > latestDecision.decidedAt ? block.updatedAt : latestDecision.decidedAt)
        : latestDecision.decidedAt;

      return {
        tradeId,
        currentResult: latestDecision.result,
        oracleProgressionBlocked: blockedFlag(blockState),
        blockState,
        latestDecisionId: latestDecision.decisionId,
        latestReasonCode: latestDecision.reasonCode,
        latestProvider: latestDecision.provider,
        latestCorrelationId: latestDecision.correlationId,
        updatedAt,
      };
    },
  };
}
