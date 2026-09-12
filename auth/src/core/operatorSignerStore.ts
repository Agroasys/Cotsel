/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { AdminActor, OperatorSignerActionClass, OperatorSignerRegisterRecord } from '../types';
import { recordAdminAuditEvent } from '../database/queries/adminAudit';
import { queryProfileByAccountIdForUpdate } from '../database/queries/profileRows';

export interface ProposeOperatorSignerInput {
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvalTicket: string;
  notes?: string | null;
  actor: AdminActor;
  reason: string;
}

export interface ApproveOperatorSignerInput {
  bindingId: string;
  evidenceDigest: string;
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
  propose(input: ProposeOperatorSignerInput): Promise<OperatorSignerRegisterRecord>;
  approve(input: ApproveOperatorSignerInput): Promise<OperatorSignerRegisterRecord>;
  revoke(input: RevokeOperatorSignerInput): Promise<OperatorSignerRegisterRecord | null>;
}

interface SignerBindingRow {
  bindingId: string;
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvingAuthority: string | null;
  approvedAt: Date | null;
  approvalTicket: string;
  notes: string | null;
  state: 'pending' | 'active' | 'revoked';
  evidenceDigest: string;
  approvedByPrincipal: string | null;
  activatedAt: Date | null;
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
  state,
  evidence_digest AS "evidenceDigest",
  approved_by_principal AS "approvedByPrincipal",
  activated_at AS "activatedAt",
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
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvalTicket: row.approvalTicket,
    notes: row.notes,
    state: row.state,
    evidenceDigest: row.evidenceDigest,
    approvedByPrincipal: row.approvedByPrincipal,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    revokedReason: row.revokedReason,
  };
}

function canonicalControlPrincipal(actor: AdminActor): string {
  if (actor.type !== 'service_auth' || actor.id.trim() === '') {
    throw new Error('Signer binding changes require an authenticated admin-control principal');
  }
  return `${actor.type}:${actor.id.trim()}`;
}

function signerProposalDigest(
  input: ProposeOperatorSignerInput,
  proposerPrincipal: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'v1',
        input.accountId,
        input.walletAddress,
        input.actionClass,
        input.environment,
        input.custodianName,
        input.approvalTicket,
        input.notes ?? null,
        proposerPrincipal,
      ]),
    )
    .digest('hex');
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

    async propose(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const proposerPrincipal = canonicalControlPrincipal(input.actor);
        const profile = await queryProfileByAccountIdForUpdate(client, input.accountId);
        if (!profile) throw new Error('Profile not found');
        if (!profile.active) throw new Error('Signer bindings require an active profile');
        if (profile.baseRole !== 'admin') {
          throw new Error('Signer bindings require a durable admin profile');
        }

        const evidenceDigest = signerProposalDigest(input, proposerPrincipal);
        const existing = await client.query<SignerBindingRow>(
          `SELECT ${SIGNER_COLUMNS}
           FROM operator_signer_bindings
           WHERE wallet_address = $1
             AND action_class = $2
             AND environment = $3
             AND state IN ('pending', 'active')
           FOR UPDATE`,
          [input.walletAddress, input.actionClass, input.environment],
        );
        if (existing.rows[0]) {
          const record = mapRow(existing.rows[0]);
          if (
            record.accountId !== input.accountId ||
            record.custodianName !== input.custodianName ||
            record.approvalTicket !== input.approvalTicket ||
            record.evidenceDigest !== evidenceDigest
          ) {
            throw new Error(
              'An open signer binding already exists with different proposal evidence',
            );
          }
          await client.query('COMMIT');
          return record;
        }

        const inserted = await client.query<SignerBindingRow>(
          `INSERT INTO operator_signer_bindings (
             account_id, wallet_address, action_class, environment,
             custodian_name, approval_ticket, notes, state, evidence_digest,
             active, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, FALSE, $9)
           RETURNING ${SIGNER_COLUMNS}`,
          [
            input.accountId,
            input.walletAddress,
            input.actionClass,
            input.environment,
            input.custodianName,
            input.approvalTicket,
            input.notes ?? null,
            evidenceDigest,
            proposerPrincipal,
          ],
        );
        const record = mapRow(inserted.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: input.accountId,
          targetUserId: profile.id,
          action: 'signer_binding_proposed',
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
            approvalTicket: record.approvalTicket,
            proposedBy: record.createdBy,
            evidenceDigest: record.evidenceDigest,
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

    async approve(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const approverPrincipal = canonicalControlPrincipal(input.actor);
        const existing = await client.query<SignerBindingRow>(
          `SELECT ${SIGNER_COLUMNS}
           FROM operator_signer_bindings
           WHERE id = $1
           FOR UPDATE`,
          [input.bindingId],
        );
        if (!existing.rows[0]) {
          throw new Error('Signer binding not found');
        }
        const record = mapRow(existing.rows[0]);
        if (record.state !== 'pending') {
          throw new Error('Signer binding is not pending approval');
        }
        if (record.createdBy === approverPrincipal) {
          throw new Error('Signer binding proposer cannot approve the same binding');
        }
        if (record.evidenceDigest !== input.evidenceDigest) {
          throw new Error('Signer binding approval digest does not match the pending proposal');
        }
        const profile = await queryProfileByAccountIdForUpdate(client, record.accountId);
        if (!profile?.active || profile.baseRole !== 'admin') {
          throw new Error('Signer binding approval requires an active durable admin profile');
        }

        const updated = await client.query<SignerBindingRow>(
          `UPDATE operator_signer_bindings
           SET state = 'active',
               active = TRUE,
               approving_authority = $2,
               approved_at = NOW(),
               approved_by_principal = $2,
               activated_at = NOW(),
               approved_digest = evidence_digest,
               updated_at = NOW()
           WHERE id = $1
             AND state = 'pending'
             AND created_by <> $2
             AND evidence_digest = $3
           RETURNING ${SIGNER_COLUMNS}`,
          [input.bindingId, approverPrincipal, input.evidenceDigest],
        );
        if (!updated.rows[0]) throw new Error('Signer binding activation conflict');
        const activated = mapRow(updated.rows[0]);
        await recordAdminAuditEvent(client, {
          accountId: activated.accountId,
          targetUserId: profile.id,
          action: 'signer_binding_activated',
          actor: input.actor,
          previousRole: profile.baseRole,
          newRole: profile.baseRole,
          reason: input.reason,
          metadata: {
            bindingId: activated.bindingId,
            proposedBy: activated.createdBy,
            approvedByPrincipal: activated.approvedByPrincipal,
            evidenceDigest: activated.evidenceDigest,
            approvalTicket: activated.approvalTicket,
          },
        });
        await client.query('COMMIT');
        return activated;
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
        const revokingPrincipal = canonicalControlPrincipal(input.actor);
        const existing = await client.query<SignerBindingRow>(
          `SELECT ${SIGNER_COLUMNS}
           FROM operator_signer_bindings
           WHERE id = $1 AND state IN ('pending', 'active')
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
           SET state = 'revoked',
               active = FALSE,
               revoked_at = NOW(),
               revoked_by = $2,
               revoked_reason = $3,
               updated_at = NOW()
           WHERE id = $1 AND state IN ('pending', 'active')
           RETURNING ${SIGNER_COLUMNS}`,
          [input.bindingId, revokingPrincipal, input.reason],
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
