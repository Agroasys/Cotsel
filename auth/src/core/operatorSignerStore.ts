/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { AdminActor, OperatorSignerActionClass, OperatorSignerRegisterRecord } from '../types';
import { recordAdminAuditEvent } from '../database/queries/adminAudit';
import { queryProfileByAccountIdForUpdate } from '../database/queries/profileRows';

export interface ProvisionOperatorSignerInput {
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvingAuthority: string;
  approvedAt: Date;
  approvalTicket: string;
  notes?: string | null;
  actor: AdminActor;
  reason: string;
}

export interface RevokeOperatorSignerInput {
  bindingId: string;
  actor: AdminActor;
  reason: string;
}

export interface OperatorSignerStore {
  list(input?: {
    accountId?: string;
    active?: boolean;
    limit?: number;
  }): Promise<OperatorSignerRegisterRecord[]>;
  provision(input: ProvisionOperatorSignerInput): Promise<OperatorSignerRegisterRecord>;
  revoke(input: RevokeOperatorSignerInput): Promise<OperatorSignerRegisterRecord | null>;
}

interface SignerBindingRow {
  bindingId: string;
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvingAuthority: string;
  approvedAt: Date;
  approvalTicket: string;
  notes: string | null;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

const SIGNER_COLUMNS = `
  id::text AS "bindingId",
  account_id AS "accountId",
  wallet_address AS "walletAddress",
  action_class AS "actionClass",
  environment,
  custodian_name AS "custodianName",
  approving_authority AS "approvingAuthority",
  approved_at AS "approvedAt",
  approval_ticket AS "approvalTicket",
  notes,
  active,
  created_by AS "createdBy",
  created_at AS "createdAt",
  revoked_at AS "revokedAt",
  revoked_by AS "revokedBy",
  revoked_reason AS "revokedReason"`;

function mapRow(row: SignerBindingRow): OperatorSignerRegisterRecord {
  return {
    bindingId: row.bindingId,
    accountId: row.accountId,
    walletAddress: row.walletAddress,
    actionClass: row.actionClass,
    environment: row.environment,
    custodianName: row.custodianName,
    approvingAuthority: row.approvingAuthority,
    approvedAt: row.approvedAt.toISOString(),
    approvalTicket: row.approvalTicket,
    notes: row.notes,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    revokedReason: row.revokedReason,
  };
}

export function createPostgresOperatorSignerStore(pool: Pool): OperatorSignerStore {
  return {
    async list(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.accountId) {
        params.push(input.accountId);
        conditions.push(`account_id = $${params.length}`);
      }
      if (input.active !== undefined) {
        params.push(input.active);
        conditions.push(`active = $${params.length}`);
      }
      params.push(limit);
      const result = await pool.query<SignerBindingRow>(
        `SELECT ${SIGNER_COLUMNS}
         FROM operator_signer_bindings
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapRow);
    },

    async provision(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const profile = await queryProfileByAccountIdForUpdate(client, input.accountId);
        if (!profile) throw new Error('Profile not found');
        if (!profile.active) throw new Error('Signer bindings require an active profile');
        if (profile.baseRole !== 'admin') {
          throw new Error('Signer bindings require a durable admin profile');
        }

        const existing = await client.query<SignerBindingRow>(
          `SELECT ${SIGNER_COLUMNS}
           FROM operator_signer_bindings
           WHERE wallet_address = $1
             AND action_class = $2
             AND environment = $3
             AND active = TRUE
           FOR UPDATE`,
          [input.walletAddress, input.actionClass, input.environment],
        );
        if (existing.rows[0]) {
          const record = mapRow(existing.rows[0]);
          if (
            record.accountId !== input.accountId ||
            record.custodianName !== input.custodianName ||
            record.approvingAuthority !== input.approvingAuthority ||
            record.approvedAt !== input.approvedAt.toISOString() ||
            record.approvalTicket !== input.approvalTicket
          ) {
            throw new Error(
              'An active signer binding already exists with different approval evidence',
            );
          }
          await client.query('COMMIT');
          return record;
        }

        const inserted = await client.query<SignerBindingRow>(
          `INSERT INTO operator_signer_bindings (
             account_id, wallet_address, action_class, environment,
             custodian_name, approving_authority, approved_at, approval_ticket,
             notes, active, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
           RETURNING ${SIGNER_COLUMNS}`,
          [
            input.accountId,
            input.walletAddress,
            input.actionClass,
            input.environment,
            input.custodianName,
            input.approvingAuthority,
            input.approvedAt,
            input.approvalTicket,
            input.notes ?? null,
            input.actor.id,
          ],
        );
        const record = mapRow(inserted.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: input.accountId,
          targetUserId: profile.id,
          action: 'signer_binding_provisioned',
          actor: input.actor,
          previousRole: profile.baseRole,
          newRole: profile.baseRole,
          reason: input.reason,
          metadata: {
            bindingId: record.bindingId,
            walletAddress: record.walletAddress,
            actionClass: record.actionClass,
            environment: record.environment,
            custodianName: record.custodianName,
            approvingAuthority: record.approvingAuthority,
            approvedAt: record.approvedAt,
            approvalTicket: record.approvalTicket,
          },
        });
        await client.query('COMMIT');
        return record;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async revoke(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query<SignerBindingRow>(
          `SELECT ${SIGNER_COLUMNS}
           FROM operator_signer_bindings
           WHERE id = $1 AND active = TRUE
           FOR UPDATE`,
          [input.bindingId],
        );
        if (!existing.rows[0]) {
          await client.query('COMMIT');
          return null;
        }
        const record = mapRow(existing.rows[0]);
        const profile = await queryProfileByAccountIdForUpdate(client, record.accountId);
        if (!profile) throw new Error('Profile not found');

        const updated = await client.query<SignerBindingRow>(
          `UPDATE operator_signer_bindings
           SET active = FALSE,
               revoked_at = NOW(),
               revoked_by = $2,
               revoked_reason = $3,
               updated_at = NOW()
           WHERE id = $1 AND active = TRUE
           RETURNING ${SIGNER_COLUMNS}`,
          [input.bindingId, input.actor.id, input.reason],
        );
        const revoked = mapRow(updated.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: revoked.accountId,
          targetUserId: profile.id,
          action: 'signer_binding_revoked',
          actor: input.actor,
          previousRole: profile.baseRole,
          newRole: profile.baseRole,
          reason: input.reason,
          metadata: {
            bindingId: revoked.bindingId,
            walletAddress: revoked.walletAddress,
            actionClass: revoked.actionClass,
            environment: revoked.environment,
            approvalTicket: revoked.approvalTicket,
          },
        });
        await client.query('COMMIT');
        return revoked;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
