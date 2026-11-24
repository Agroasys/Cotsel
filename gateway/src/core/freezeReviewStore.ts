import type { Pool, PoolClient } from 'pg';
import type { FreezeRequest } from '@agroasys/shared-db/freezeRequests';
import { GatewayError } from '../errors';

export interface FreezeReview {
  requestId: string;
  request: FreezeRequest;
  decision: 'approved' | 'rejected';
  reviewedBy: string;
  reviewedAt: string;
  reason: string;
  ticketRef: string;
}
export interface FreezeReviewStore {
  statuses(requestIds: string[]): Promise<
    Record<
      string,
      {
        review: FreezeReview | null;
        action: {
          actionId: string;
          status: string;
          verificationState: string;
          txHash: string | null;
        } | null;
      }
    >
  >;
  get(requestId: string): Promise<FreezeReview | null>;
  review(input: {
    request: FreezeRequest;
    decision: 'approved' | 'rejected';
    actor: string;
    reason: string;
    ticketRef: string;
    requestId: string;
    audit: (client: PoolClient, review: FreezeReview) => Promise<void>;
  }): Promise<FreezeReview>;
}
const columns = `request_id AS "requestId", request, decision, reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt", reason, ticket_ref AS "ticketRef"`;
type Row = Omit<FreezeReview, 'reviewedAt'> & { reviewedAt: Date };
const present = (row: Row): FreezeReview => ({ ...row, reviewedAt: row.reviewedAt.toISOString() });

export function createPostgresFreezeReviewStore(pool: Pool): FreezeReviewStore {
  return {
    async statuses(requestIds) {
      if (!requestIds.length) return {};
      const reviews = await pool.query<Row>(
        `SELECT ${columns} FROM reconciliation_freeze_reviews WHERE request_id = ANY($1::text[])`,
        [requestIds],
      );
      const actions = await pool.query(
        `SELECT DISTINCT ON (signer_policy_evidence->'reconciliationFreezeRequest'->'request'->>'requestId')
        signer_policy_evidence->'reconciliationFreezeRequest'->'request'->>'requestId' AS "requestId",
        action_id AS "actionId", status, verification_state AS "verificationState", tx_hash AS "txHash"
        FROM governance_actions WHERE contract_method = 'pauseTrade'
        AND signer_policy_evidence->'reconciliationFreezeRequest'->'request'->>'requestId' = ANY($1::text[])
        ORDER BY signer_policy_evidence->'reconciliationFreezeRequest'->'request'->>'requestId', created_at DESC, action_id DESC`,
        [requestIds],
      );
      return Object.fromEntries(
        requestIds.map((id) => [
          id,
          {
            review: reviews.rows.find((row) => row.requestId === id)
              ? present(reviews.rows.find((row) => row.requestId === id)!)
              : null,
            action: (() => {
              const action = actions.rows.find((row) => row.requestId === id);
              return action
                ? {
                    actionId: action.actionId,
                    status: action.status,
                    verificationState: action.verificationState,
                    txHash: action.txHash,
                  }
                : null;
            })(),
          },
        ]),
      );
    },
    async get(requestId) {
      const result = await pool.query<Row>(
        `SELECT ${columns} FROM reconciliation_freeze_reviews WHERE request_id = $1`,
        [requestId],
      );
      return result.rows[0] ? present(result.rows[0]) : null;
    },
    async review(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<Row>(
          `INSERT INTO reconciliation_freeze_reviews
          (request_id, request, decision, reviewed_by, reason, ticket_ref, request_trace_id)
          VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
          ON CONFLICT (request_id) DO NOTHING RETURNING ${columns}`,
          [
            input.request.requestId,
            JSON.stringify(input.request),
            input.decision,
            input.actor,
            input.reason,
            input.ticketRef,
            input.requestId,
          ],
        );
        let record: FreezeReview;
        if (!result.rows[0]) {
          const existing = await client.query<Row>(
            `SELECT ${columns} FROM reconciliation_freeze_reviews WHERE request_id = $1`,
            [input.request.requestId],
          );
          record = present(existing.rows[0]);
          if (record.decision !== input.decision)
            throw new GatewayError(
              409,
              'CONFLICT',
              'The freeze request already has a different recorded decision',
            );
        } else {
          record = present(result.rows[0]);
          await input.audit(client, record);
        }
        await client.query('COMMIT');
        return record;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
