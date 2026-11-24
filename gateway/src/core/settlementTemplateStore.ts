/**
 * SPDX-License-Identifier: Apache-2.0
 */
// Versioned settlement templates (Cotsel#940). Versions move draft -> reviewed
// -> active -> retired. Review and activation need someone other than the
// author, and only allowlisted versions may become active: the escrow still
// enforces LaunchSettlementSchedule, so activating different terms would
// describe settlements the contract does not run (until #955). Migration 017
// enforces the same rules and the immutability of terms in PostgreSQL.
import type { Pool, PoolClient } from 'pg';
import {
  AGROASYS_LAUNCH_TEMPLATE_V1,
  settlementTemplateHash,
  settlementTemplateProblems,
  type SettlementTemplate,
} from '@agroasys/sdk';
import { GatewayError } from '../errors';

export type SettlementTemplateStatus = 'draft' | 'reviewed' | 'active' | 'retired';

/** The template every new settlement is recorded against. */
export const LAUNCH_SETTLEMENT_TEMPLATE_ID = AGROASYS_LAUNCH_TEMPLATE_V1.templateId;
export const DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST: readonly string[] = Object.freeze([
  `${AGROASYS_LAUNCH_TEMPLATE_V1.templateId}:${AGROASYS_LAUNCH_TEMPLATE_V1.version}`,
]);

export interface SettlementTemplateReference {
  templateId: string;
  version: number;
  templateHash: string;
}

export interface SettlementTemplateRecord extends SettlementTemplateReference {
  schemaVersion: string;
  template: SettlementTemplate;
  status: SettlementTemplateStatus;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  requestId: string;
}

export type SettlementTemplateAction = 'created' | 'reviewed' | 'activated' | 'retired';

/**
 * Writes the audit record of a template change inside the transaction that
 * makes the change, so a change is never committed without it.
 */
export type SettlementTemplateAudit = (
  db: Pick<PoolClient, 'query'>,
  event: {
    action: SettlementTemplateAction;
    record: SettlementTemplateRecord;
    /** On activation: the previously active version this one replaced. */
    replaced?: SettlementTemplateRecord | null;
  },
) => Promise<void>;

export interface SettlementTemplateTransitionInput {
  templateId: string;
  version: number;
  actor: string;
  audit?: SettlementTemplateAudit;
}

export interface SettlementTemplateStore {
  list(templateId?: string): Promise<SettlementTemplateRecord[]>;
  get(templateId: string, version: number): Promise<SettlementTemplateRecord | null>;
  getActive(templateId: string): Promise<SettlementTemplateRecord | null>;
  createDraft(input: {
    template: SettlementTemplate;
    actor: string;
    requestId: string;
    audit?: SettlementTemplateAudit;
  }): Promise<SettlementTemplateRecord>;
  review(input: SettlementTemplateTransitionInput): Promise<SettlementTemplateRecord>;
  /**
   * Retires a draft or reviewed version. A version becomes active, and the
   * active one is retired, only through the governed activation workflow
   * (settlementTemplateActivationStore, migration 018).
   */
  retire(input: SettlementTemplateTransitionInput): Promise<SettlementTemplateRecord>;
}

export interface SettlementTemplateRow {
  templateId: string;
  version: number;
  schemaVersion: string;
  template: SettlementTemplate;
  templateHash: string;
  status: SettlementTemplateStatus;
  createdBy: string;
  createdAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  activatedBy: string | null;
  activatedAt: Date | null;
  retiredBy: string | null;
  retiredAt: Date | null;
  requestId: string;
}

export const SETTLEMENT_TEMPLATE_COLUMNS = `
  template_id AS "templateId",
  version,
  schema_version AS "schemaVersion",
  template,
  template_hash AS "templateHash",
  status,
  created_by AS "createdBy",
  created_at AS "createdAt",
  reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt",
  activated_by AS "activatedBy",
  activated_at AS "activatedAt",
  retired_by AS "retiredBy",
  retired_at AS "retiredAt",
  request_id AS "requestId"`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function mapSettlementTemplateRow(row: SettlementTemplateRow): SettlementTemplateRecord {
  // JSONB does not keep key order, so the hash is recomputed canonically. A
  // mismatch means the stored terms are not the ones that were reviewed.
  if (settlementTemplateHash(row.template) !== row.templateHash) {
    throw new GatewayError(
      500,
      'INTERNAL_ERROR',
      'Stored settlement template does not match its hash',
      { templateId: row.templateId, version: row.version },
    );
  }
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: iso(row.reviewedAt),
    activatedAt: iso(row.activatedAt),
    retiredAt: iso(row.retiredAt),
  };
}

function notFound(templateId: string, version: number): GatewayError {
  return new GatewayError(404, 'NOT_FOUND', 'Settlement template version not found', {
    templateId,
    version,
  });
}

function conflict(message: string, details: Record<string, unknown>): GatewayError {
  return new GatewayError(409, 'CONFLICT', message, details);
}

export function createPostgresSettlementTemplateStore(pool: Pool): SettlementTemplateStore {
  async function lockVersion(
    client: PoolClient,
    templateId: string,
    version: number,
  ): Promise<SettlementTemplateRow> {
    const result = await client.query<SettlementTemplateRow>(
      `SELECT ${SETTLEMENT_TEMPLATE_COLUMNS} FROM settlement_templates
       WHERE template_id = $1 AND version = $2 FOR UPDATE`,
      [templateId, version],
    );
    if (!result.rows[0]) throw notFound(templateId, version);
    return result.rows[0];
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function transition(
    client: PoolClient,
    row: SettlementTemplateRow,
    status: SettlementTemplateStatus,
    actorColumn: 'reviewed' | 'activated' | 'retired',
    actor: string,
  ): Promise<SettlementTemplateRecord> {
    const result = await client.query<SettlementTemplateRow>(
      `UPDATE settlement_templates
       SET status = $3, ${actorColumn}_by = $4, ${actorColumn}_at = NOW()
       WHERE template_id = $1 AND version = $2
       RETURNING ${SETTLEMENT_TEMPLATE_COLUMNS}`,
      [row.templateId, row.version, status, actor],
    );
    return mapSettlementTemplateRow(result.rows[0]);
  }

  return {
    async list(templateId) {
      const result = await pool.query<SettlementTemplateRow>(
        `SELECT ${SETTLEMENT_TEMPLATE_COLUMNS} FROM settlement_templates
         WHERE ($1::text IS NULL OR template_id = $1)
         ORDER BY template_id, version`,
        [templateId ?? null],
      );
      return result.rows.map(mapSettlementTemplateRow);
    },

    async get(templateId, version) {
      const result = await pool.query<SettlementTemplateRow>(
        `SELECT ${SETTLEMENT_TEMPLATE_COLUMNS} FROM settlement_templates WHERE template_id = $1 AND version = $2`,
        [templateId, version],
      );
      return result.rows[0] ? mapSettlementTemplateRow(result.rows[0]) : null;
    },

    async getActive(templateId) {
      const result = await pool.query<SettlementTemplateRow>(
        `SELECT ${SETTLEMENT_TEMPLATE_COLUMNS} FROM settlement_templates WHERE template_id = $1 AND status = 'active'`,
        [templateId],
      );
      return result.rows[0] ? mapSettlementTemplateRow(result.rows[0]) : null;
    },

    async createDraft({ template, actor, requestId, audit }) {
      const problems = settlementTemplateProblems(template);
      if (problems.length > 0) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Settlement template is invalid', {
          problems,
        });
      }
      const templateHash = settlementTemplateHash(template);
      return inTransaction(async (client) => {
        const result = await client.query<SettlementTemplateRow>(
          `INSERT INTO settlement_templates (
           template_id, version, schema_version, template, template_hash, created_by, request_id
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING ${SETTLEMENT_TEMPLATE_COLUMNS}`,
          [
            template.templateId,
            template.version,
            template.schemaVersion,
            JSON.stringify(template),
            templateHash,
            actor,
            requestId,
          ],
        );
        if (!result.rows[0]) {
          throw conflict('Settlement template version or terms already exist', {
            templateId: template.templateId,
            version: template.version,
            templateHash,
          });
        }
        const record = mapSettlementTemplateRow(result.rows[0]);
        await audit?.(client, { action: 'created', record });
        return record;
      });
    },

    review({ templateId, version, actor, audit }) {
      return inTransaction(async (client) => {
        const row = await lockVersion(client, templateId, version);
        if (row.status !== 'draft') {
          throw conflict('Only a draft can be reviewed', {
            templateId,
            version,
            status: row.status,
          });
        }
        if (row.createdBy === actor) {
          throw conflict('A template must be reviewed by someone other than its author', {
            templateId,
            version,
          });
        }
        const record = await transition(client, row, 'reviewed', 'reviewed', actor);
        await audit?.(client, { action: 'reviewed', record });
        return record;
      });
    },

    retire({ templateId, version, actor, audit }) {
      return inTransaction(async (client) => {
        const row = await lockVersion(client, templateId, version);
        if (row.status === 'retired') {
          throw conflict('Template version is already retired', { templateId, version });
        }
        // Retiring the active version would leave no terms, and every new
        // settlement would be refused. It is replaced only by activating another.
        if (row.status === 'active') {
          throw conflict('The active template is retired only by activating a replacement', {
            templateId,
            version,
            reason: 'active_template_requires_replacement',
          });
        }
        const record = await transition(client, row, 'retired', 'retired', actor);
        await audit?.(client, { action: 'retired', record });
        return record;
      });
    },
  };
}
