/**
 * SPDX-License-Identifier: Apache-2.0
 */
// Governed settlement template activation (Cotsel#940, review R05).
//
// prepare  -> records the exact target (id, version, terms hash) and the exact
//             version it will replace, or none.
// approve  -> a different person approves that exact preparation. The approver
//             is neither its preparer nor the template's author.
// confirm  -> under lock, re-checks the target and the expected predecessor,
//             then retires the predecessor and activates the target in one
//             transaction with its audit row. A preparation whose predecessor
//             or target changed is marked superseded and refused (409).
//
// Migration 018 enforces the same lifecycle and refuses any activation without
// a confirmed preparation, so no other path can activate terms.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GatewayError } from '../errors';
import {
  DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST,
  SETTLEMENT_TEMPLATE_COLUMNS,
  mapSettlementTemplateRow,
  type SettlementTemplateRecord,
  type SettlementTemplateRow,
} from './settlementTemplateStore';

export type TemplateActivationState = 'prepared' | 'approved' | 'confirmed' | 'superseded';

export interface TemplateActivationRecord {
  preparationId: string;
  templateId: string;
  version: number;
  templateHash: string;
  expectedActiveVersion: number | null;
  expectedActiveHash: string | null;
  state: TemplateActivationState;
  preparedBy: string;
  preparedAt: string;
  expiresAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
}

export type TemplateActivationAction =
  'activation_prepared' | 'activation_approved' | 'activation_superseded' | 'activated';

/** Writes the audit row inside the transaction that makes the change. */
export type TemplateActivationAudit = (
  db: Pick<PoolClient, 'query'>,
  event: {
    action: TemplateActivationAction;
    preparation: TemplateActivationRecord;
    activated?: SettlementTemplateRecord;
    retired?: SettlementTemplateRecord | null;
  },
) => Promise<void>;

export interface TemplateActivationChange {
  actor: string;
  requestId: string;
  audit?: TemplateActivationAudit;
}

export interface TemplateActivationStore {
  list(templateId?: string): Promise<TemplateActivationRecord[]>;
  get(preparationId: string): Promise<TemplateActivationRecord | null>;
  prepare(
    input: { templateId: string; version: number } & TemplateActivationChange,
  ): Promise<TemplateActivationRecord>;
  approve(
    input: { preparationId: string } & TemplateActivationChange,
  ): Promise<TemplateActivationRecord>;
  confirm(input: { preparationId: string } & TemplateActivationChange): Promise<{
    preparation: TemplateActivationRecord;
    activated: SettlementTemplateRecord;
    retired: SettlementTemplateRecord | null;
  }>;
}

interface ActivationRow {
  preparationId: string;
  templateId: string;
  version: number;
  templateHash: string;
  expectedActiveVersion: number | null;
  expectedActiveHash: string | null;
  state: TemplateActivationState;
  preparedBy: string;
  preparedAt: Date;
  expiresAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  supersededAt: Date | null;
  supersededReason: string | null;
}

const ACTIVATION_COLUMNS = `
  preparation_id AS "preparationId",
  template_id AS "templateId",
  version,
  template_hash AS "templateHash",
  expected_active_version AS "expectedActiveVersion",
  expected_active_hash AS "expectedActiveHash",
  state,
  prepared_by AS "preparedBy",
  prepared_at AS "preparedAt",
  expires_at AS "expiresAt",
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  confirmed_by AS "confirmedBy",
  confirmed_at AS "confirmedAt",
  superseded_at AS "supersededAt",
  superseded_reason AS "supersededReason"`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function mapActivation(row: ActivationRow): TemplateActivationRecord {
  return {
    ...row,
    preparedAt: row.preparedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    approvedAt: iso(row.approvedAt),
    confirmedAt: iso(row.confirmedAt),
    supersededAt: iso(row.supersededAt),
  };
}

const conflict = (message: string, details: Record<string, unknown>) =>
  new GatewayError(409, 'CONFLICT', message, details);

/** A preparation is valid for this long before it must be prepared again. */
export const TEMPLATE_ACTIVATION_TTL_SECONDS = 24 * 60 * 60;

export function createPostgresTemplateActivationStore(
  pool: Pool,
  options: { activationAllowlist?: readonly string[]; ttlSeconds?: number } = {},
): TemplateActivationStore {
  const allowlist = new Set(options.activationAllowlist ?? DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST);
  const ttlSeconds = options.ttlSeconds ?? TEMPLATE_ACTIVATION_TTL_SECONDS;

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

  /** Locks every version of the template, so activations of it serialise. */
  async function lockTemplate(client: PoolClient, templateId: string) {
    const result = await client.query<SettlementTemplateRow>(
      `SELECT ${SETTLEMENT_TEMPLATE_COLUMNS} FROM settlement_templates
       WHERE template_id = $1 ORDER BY version FOR UPDATE`,
      [templateId],
    );
    return result.rows;
  }

  async function lockPreparation(client: PoolClient, preparationId: string) {
    const result = await client.query<ActivationRow>(
      `SELECT ${ACTIVATION_COLUMNS} FROM settlement_template_activations
       WHERE preparation_id = $1 FOR UPDATE`,
      [preparationId],
    );
    if (!result.rows[0]) {
      throw new GatewayError(404, 'NOT_FOUND', 'Template activation preparation not found', {
        preparationId,
      });
    }
    return result.rows[0];
  }

  /** Why this preparation can no longer be confirmed, or null if it still holds. */
  function staleReason(prep: ActivationRow, versions: SettlementTemplateRow[]): string | null {
    const target = versions.find((row) => row.version === prep.version);
    if (!target || target.status !== 'reviewed') return 'target_not_reviewed';
    if (target.templateHash !== prep.templateHash) return 'target_terms_changed';
    const active = versions.find((row) => row.status === 'active') ?? null;
    if ((active?.version ?? null) !== prep.expectedActiveVersion) return 'active_version_changed';
    if ((active?.templateHash ?? null) !== prep.expectedActiveHash) return 'active_terms_changed';
    return null;
  }

  async function supersede(
    client: PoolClient,
    prep: ActivationRow,
    reason: string,
    audit?: TemplateActivationAudit,
  ) {
    const result = await client.query<ActivationRow>(
      `UPDATE settlement_template_activations
       SET state = 'superseded', superseded_at = NOW(), superseded_reason = $2
       WHERE preparation_id = $1 RETURNING ${ACTIVATION_COLUMNS}`,
      [prep.preparationId, reason],
    );
    const preparation = mapActivation(result.rows[0]);
    await audit?.(client, { action: 'activation_superseded', preparation });
    return preparation;
  }

  return {
    async list(templateId) {
      const result = await pool.query<ActivationRow>(
        `SELECT ${ACTIVATION_COLUMNS} FROM settlement_template_activations
         WHERE ($1::text IS NULL OR template_id = $1)
         ORDER BY prepared_at DESC, preparation_id`,
        [templateId ?? null],
      );
      return result.rows.map(mapActivation);
    },

    async get(preparationId) {
      const result = await pool.query<ActivationRow>(
        `SELECT ${ACTIVATION_COLUMNS} FROM settlement_template_activations WHERE preparation_id = $1`,
        [preparationId],
      );
      return result.rows[0] ? mapActivation(result.rows[0]) : null;
    },

    prepare({ templateId, version, actor, requestId, audit }) {
      return inTransaction(async (client) => {
        const versions = await lockTemplate(client, templateId);
        const target = versions.find((row) => row.version === version);
        if (!target) {
          throw new GatewayError(404, 'NOT_FOUND', 'Settlement template version not found', {
            templateId,
            version,
          });
        }
        if (target.status !== 'reviewed') {
          throw conflict('Only a reviewed template can be prepared for activation', {
            templateId,
            version,
            status: target.status,
          });
        }
        if (!allowlist.has(`${templateId}:${version}`)) {
          throw conflict('The escrow contract does not enforce this template version', {
            templateId,
            version,
            reason: 'template_not_enforced_by_contract',
          });
        }
        const active = versions.find((row) => row.status === 'active') ?? null;
        const result = await client.query<ActivationRow>(
          `INSERT INTO settlement_template_activations (
             preparation_id, template_id, version, template_hash,
             expected_active_version, expected_active_hash,
             prepared_by, prepare_request_id, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 * INTERVAL '1 second'))
           RETURNING ${ACTIVATION_COLUMNS}`,
          [
            randomUUID(),
            templateId,
            version,
            target.templateHash,
            active?.version ?? null,
            active?.templateHash ?? null,
            actor,
            requestId,
            ttlSeconds,
          ],
        );
        const preparation = mapActivation(result.rows[0]);
        await audit?.(client, { action: 'activation_prepared', preparation });
        return preparation;
      });
    },

    approve({ preparationId, actor, requestId, audit }) {
      return inTransaction(async (client) => {
        const prep = await lockPreparation(client, preparationId);
        if (prep.state !== 'prepared') {
          throw conflict('Only a prepared activation can be approved', {
            preparationId,
            state: prep.state,
          });
        }
        if (prep.expiresAt.getTime() <= Date.now()) {
          throw conflict('The activation preparation has expired; prepare it again', {
            preparationId,
            reason: 'activation_preparation_expired',
          });
        }
        const versions = await lockTemplate(client, prep.templateId);
        const target = versions.find((row) => row.version === prep.version);
        if (prep.preparedBy === actor || target?.createdBy === actor) {
          throw conflict(
            'An activation must be approved by someone other than its preparer and the template author',
            { preparationId, reason: 'independent_approval_required' },
          );
        }
        const stale = staleReason(prep, versions);
        if (stale) {
          await supersede(client, prep, stale, audit);
          throw conflict('The activation preparation is stale; prepare it again', {
            preparationId,
            reason: 'activation_preparation_stale',
            detail: stale,
          });
        }
        const result = await client.query<ActivationRow>(
          `UPDATE settlement_template_activations
           SET state = 'approved', approved_by = $2, approved_at = NOW(), approve_request_id = $3
           WHERE preparation_id = $1 RETURNING ${ACTIVATION_COLUMNS}`,
          [preparationId, actor, requestId],
        );
        const preparation = mapActivation(result.rows[0]);
        await audit?.(client, { action: 'activation_approved', preparation });
        return preparation;
      });
    },

    async confirm({ preparationId, actor, requestId, audit }) {
      // A refusal that supersedes a stale preparation must still commit that
      // record, so the transaction returns the refusal instead of throwing.
      const outcome = await inTransaction(async (client) => {
        const prep = await lockPreparation(client, preparationId);
        if (prep.state === 'confirmed') {
          return {
            refusal: conflict('The activation was already confirmed', {
              preparationId,
              reason: 'activation_already_confirmed',
            }),
          };
        }
        if (prep.state !== 'approved') {
          return {
            refusal: conflict('Only an approved activation can be confirmed', {
              preparationId,
              state: prep.state,
            }),
          };
        }
        if (prep.expiresAt.getTime() <= Date.now()) {
          return {
            refusal: conflict('The activation preparation has expired; prepare it again', {
              preparationId,
              reason: 'activation_preparation_expired',
            }),
          };
        }
        const versions = await lockTemplate(client, prep.templateId);
        const target = versions.find((row) => row.version === prep.version)!;
        if (target.createdBy === actor) {
          return {
            refusal: conflict('A template must be activated by someone other than its author', {
              preparationId,
              reason: 'independent_activation_required',
            }),
          };
        }
        const stale = staleReason(prep, versions);
        if (stale) {
          await supersede(client, prep, stale, audit);
          return {
            refusal: conflict('The activation preparation is stale; prepare it again', {
              preparationId,
              reason: 'activation_preparation_stale',
              detail: stale,
            }),
          };
        }
        const confirmed = await client.query<ActivationRow>(
          `UPDATE settlement_template_activations
           SET state = 'confirmed', confirmed_by = $2, confirmed_at = NOW(), confirm_request_id = $3
           WHERE preparation_id = $1 RETURNING ${ACTIVATION_COLUMNS}`,
          [preparationId, actor, requestId],
        );
        const transition = async (version: number, status: 'active' | 'retired') => {
          const column = status === 'active' ? 'activated' : 'retired';
          const result = await client.query<SettlementTemplateRow>(
            `UPDATE settlement_templates SET status = $3, ${column}_by = $4, ${column}_at = NOW()
             WHERE template_id = $1 AND version = $2 RETURNING ${SETTLEMENT_TEMPLATE_COLUMNS}`,
            [prep.templateId, version, status, actor],
          );
          return mapSettlementTemplateRow(result.rows[0]);
        };
        const retired =
          prep.expectedActiveVersion === null
            ? null
            : await transition(prep.expectedActiveVersion, 'retired');
        const activated = await transition(prep.version, 'active');
        const preparation = mapActivation(confirmed.rows[0]);
        await audit?.(client, { action: 'activated', preparation, activated, retired });
        return { result: { preparation, activated, retired } };
      });
      if ('refusal' in outcome) throw outcome.refusal;
      return outcome.result;
    },
  };
}
