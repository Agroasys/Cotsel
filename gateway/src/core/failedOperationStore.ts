/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { Pool } from 'pg';
import type { GatewayFailureClass } from './errorEnvelope';

export type FailedOperationState = 'open' | 'replayed' | 'replay_failed';

export interface FailedOperationRecord {
  failedOperationId: string;
  operationType: string;
  operationKey: string;
  targetService: string;
  route: string;
  method: string;
  payloadHash: string;
  requestPayload: Record<string, unknown> | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey: string | null;
  actionKey: string | null;
  actorId: string | null;
  actorUserId: string | null;
  actorWalletAddress: string | null;
  actorRole: string | null;
  sessionReference: string | null;
  replayEligible: boolean;
  failureState: FailedOperationState;
  firstFailedAt: string;
  lastFailedAt: string;
  retryCount: number;
  terminalErrorClass: GatewayFailureClass;
  terminalErrorCode: string;
  terminalErrorMessage: string;
  metadata: Record<string, unknown>;
  lastReplayedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FailedOperationStore {
  recordFailure(input: RecordFailedOperationInput): Promise<FailedOperationRecord>;
  get(failedOperationId: string): Promise<FailedOperationRecord | null>;
  list(input?: ListFailedOperationsInput): Promise<FailedOperationRecord[]>;
  markReplayed(
    failedOperationId: string,
    replayedAt: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  markReplayFailed(
    failedOperationId: string,
    replayedAt: string,
    failure: Pick<
      RecordFailedOperationInput,
      'terminalErrorClass' | 'terminalErrorCode' | 'terminalErrorMessage'
    >,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface RecordFailedOperationInput {
  operationType: string;
  operationKey: string;
  targetService: string;
  route: string;
  method: string;
  requestPayload?: Record<string, unknown> | null;
  requestId: string;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  actionKey?: string | null;
  actorId?: string | null;
  actorUserId?: string | null;
  actorWalletAddress?: string | null;
  actorRole?: string | null;
  sessionReference?: string | null;
  replayEligible: boolean;
  terminalErrorClass: GatewayFailureClass;
  terminalErrorCode: string;
  terminalErrorMessage: string;
  failedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ListFailedOperationsInput {
  failureState?: FailedOperationState;
  replayEligible?: boolean;
}

export class FailedOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailedOperationConflictError';
  }
}

interface FailedOperationRow {
  failedOperationId: string;
  operationType: string;
  operationKey: string;
  targetService: string;
  route: string;
  method: string;
  payloadHash: string;
  requestPayload: Record<string, unknown> | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey: string | null;
  actionKey: string | null;
  actorId: string | null;
  actorUserId: string | null;
  actorWalletAddress: string | null;
  actorRole: string | null;
  sessionReference: string | null;
  replayEligible: boolean;
  failureState: FailedOperationState;
  firstFailedAt: Date;
  lastFailedAt: Date;
  retryCount: number;
  terminalErrorClass: GatewayFailureClass;
  terminalErrorCode: string;
  terminalErrorMessage: string;
  metadata: Record<string, unknown>;
  lastReplayedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: FailedOperationRow): FailedOperationRecord {
  return {
    failedOperationId: row.failedOperationId,
    operationType: row.operationType,
    operationKey: row.operationKey,
    targetService: row.targetService,
    route: row.route,
    method: row.method,
    payloadHash: row.payloadHash,
    requestPayload: row.requestPayload || null,
    requestId: row.requestId,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    actionKey: row.actionKey,
    actorId: row.actorId,
    actorUserId: row.actorUserId,
    actorWalletAddress: row.actorWalletAddress,
    actorRole: row.actorRole,
    sessionReference: row.sessionReference,
    replayEligible: row.replayEligible,
    failureState: row.failureState,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
    retryCount: row.retryCount,
    terminalErrorClass: row.terminalErrorClass,
    terminalErrorCode: row.terminalErrorCode,
    terminalErrorMessage: row.terminalErrorMessage,
    metadata: row.metadata || {},
    lastReplayedAt: row.lastReplayedAt ? row.lastReplayedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildPayloadHash(requestPayload: Record<string, unknown> | null | undefined): string {
  const serialized = requestPayload ? JSON.stringify(requestPayload) : '';
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function toScopedKey(operationType: string, operationKey: string): string {
  return `${operationType}\u0000${operationKey}`;
}

export function createPostgresFailedOperationStore(pool: Pool): FailedOperationStore {
  return {
    async recordFailure(input) {
      const result = await pool.query<FailedOperationRow>(
        `INSERT INTO failed_operations (
           operation_type,
           operation_key,
           target_service,
           route,
           method,
           payload_hash,
           request_payload,
           request_id,
           correlation_id,
           idempotency_key,
           action_key,
           actor_id,
           actor_user_id,
           actor_wallet_address,
           actor_role,
           session_reference,
           replay_eligible,
           failure_state,
           first_failed_at,
           last_failed_at,
           retry_count,
           terminal_error_class,
           terminal_error_code,
           terminal_error_message,
           metadata,
           last_replayed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16,
           $17, 'open', $18, $18, 1, $19, $20, $21, $22::jsonb, NULL
         )
         ON CONFLICT (operation_type, operation_key) DO UPDATE SET
           target_service = EXCLUDED.target_service,
           route = EXCLUDED.route,
           method = EXCLUDED.method,
           payload_hash = EXCLUDED.payload_hash,
           request_payload = EXCLUDED.request_payload,
           request_id = EXCLUDED.request_id,
           correlation_id = EXCLUDED.correlation_id,
           idempotency_key = EXCLUDED.idempotency_key,
           action_key = EXCLUDED.action_key,
           actor_id = EXCLUDED.actor_id,
           actor_user_id = EXCLUDED.actor_user_id,
           actor_wallet_address = EXCLUDED.actor_wallet_address,
           actor_role = EXCLUDED.actor_role,
           session_reference = EXCLUDED.session_reference,
           replay_eligible = EXCLUDED.replay_eligible,
           failure_state = 'open',
           last_failed_at = EXCLUDED.last_failed_at,
           retry_count = failed_operations.retry_count + 1,
           terminal_error_class = EXCLUDED.terminal_error_class,
           terminal_error_code = EXCLUDED.terminal_error_code,
           terminal_error_message = EXCLUDED.terminal_error_message,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         WHERE failed_operations.payload_hash = EXCLUDED.payload_hash
         RETURNING
           failed_operation_id AS "failedOperationId",
           operation_type AS "operationType",
           operation_key AS "operationKey",
           target_service AS "targetService",
           route,
           method,
           payload_hash AS "payloadHash",
           request_payload AS "requestPayload",
           request_id AS "requestId",
           correlation_id AS "correlationId",
           idempotency_key AS "idempotencyKey",
           action_key AS "actionKey",
           actor_id AS "actorId",
           actor_user_id AS "actorUserId",
           actor_wallet_address AS "actorWalletAddress",
           actor_role AS "actorRole",
           session_reference AS "sessionReference",
           replay_eligible AS "replayEligible",
           failure_state AS "failureState",
           first_failed_at AS "firstFailedAt",
           last_failed_at AS "lastFailedAt",
           retry_count AS "retryCount",
           terminal_error_class AS "terminalErrorClass",
           terminal_error_code AS "terminalErrorCode",
           terminal_error_message AS "terminalErrorMessage",
           metadata,
           last_replayed_at AS "lastReplayedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          input.operationType,
          input.operationKey,
          input.targetService,
          input.route,
          input.method,
          buildPayloadHash(input.requestPayload),
          JSON.stringify(input.requestPayload ?? null),
          input.requestId,
          input.correlationId ?? null,
          input.idempotencyKey ?? null,
          input.actionKey ?? null,
          input.actorId ?? null,
          input.actorUserId ?? null,
          input.actorWalletAddress ?? null,
          input.actorRole ?? null,
          input.sessionReference ?? null,
          input.replayEligible,
          input.failedAt,
          input.terminalErrorClass,
          input.terminalErrorCode,
          input.terminalErrorMessage,
          JSON.stringify(input.metadata ?? {}),
        ],
      );

      if (!result.rows[0]) {
        throw new FailedOperationConflictError(
          'Failed operation key was reused with a conflicting payload',
        );
      }

      return mapRow(result.rows[0]!);
    },

    async get(failedOperationId) {
      const result = await pool.query<FailedOperationRow>(
        `SELECT
           failed_operation_id AS "failedOperationId",
           operation_type AS "operationType",
           operation_key AS "operationKey",
           target_service AS "targetService",
           route,
           method,
           payload_hash AS "payloadHash",
           request_payload AS "requestPayload",
           request_id AS "requestId",
           correlation_id AS "correlationId",
           idempotency_key AS "idempotencyKey",
           action_key AS "actionKey",
           actor_id AS "actorId",
           actor_user_id AS "actorUserId",
           actor_wallet_address AS "actorWalletAddress",
           actor_role AS "actorRole",
           session_reference AS "sessionReference",
           replay_eligible AS "replayEligible",
           failure_state AS "failureState",
           first_failed_at AS "firstFailedAt",
           last_failed_at AS "lastFailedAt",
           retry_count AS "retryCount",
           terminal_error_class AS "terminalErrorClass",
           terminal_error_code AS "terminalErrorCode",
           terminal_error_message AS "terminalErrorMessage",
           metadata,
           last_replayed_at AS "lastReplayedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM failed_operations
         WHERE failed_operation_id = $1`,
        [failedOperationId],
      );

      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async list(input = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.failureState) {
        params.push(input.failureState);
        conditions.push(`failure_state = $${params.length}`);
      }

      if (input.replayEligible !== undefined) {
        params.push(input.replayEligible);
        conditions.push(`replay_eligible = $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query<FailedOperationRow>(
        `SELECT
           failed_operation_id AS "failedOperationId",
           operation_type AS "operationType",
           operation_key AS "operationKey",
           target_service AS "targetService",
           route,
           method,
           payload_hash AS "payloadHash",
           request_payload AS "requestPayload",
           request_id AS "requestId",
           correlation_id AS "correlationId",
           idempotency_key AS "idempotencyKey",
           action_key AS "actionKey",
           actor_id AS "actorId",
           actor_user_id AS "actorUserId",
           actor_wallet_address AS "actorWalletAddress",
           actor_role AS "actorRole",
           session_reference AS "sessionReference",
           replay_eligible AS "replayEligible",
           failure_state AS "failureState",
           first_failed_at AS "firstFailedAt",
           last_failed_at AS "lastFailedAt",
           retry_count AS "retryCount",
           terminal_error_class AS "terminalErrorClass",
           terminal_error_code AS "terminalErrorCode",
           terminal_error_message AS "terminalErrorMessage",
           metadata,
           last_replayed_at AS "lastReplayedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM failed_operations
         ${whereClause}
         ORDER BY last_failed_at DESC, failed_operation_id DESC`,
        params,
      );

      return result.rows.map(mapRow);
    },

    async markReplayed(failedOperationId, replayedAt, metadata = {}) {
      await pool.query(
        `UPDATE failed_operations
         SET failure_state = 'replayed',
             last_replayed_at = $2,
             metadata = metadata || $3::jsonb,
             updated_at = NOW()
         WHERE failed_operation_id = $1`,
        [failedOperationId, replayedAt, JSON.stringify(metadata)],
      );
    },

    async markReplayFailed(failedOperationId, replayedAt, failure, metadata = {}) {
      await pool.query(
        `UPDATE failed_operations
         SET failure_state = 'replay_failed',
             last_replayed_at = $2,
             terminal_error_class = $3,
             terminal_error_code = $4,
             terminal_error_message = $5,
             metadata = metadata || $6::jsonb,
             updated_at = NOW()
         WHERE failed_operation_id = $1`,
        [
          failedOperationId,
          replayedAt,
          failure.terminalErrorClass,
          failure.terminalErrorCode,
          failure.terminalErrorMessage,
          JSON.stringify(metadata),
        ],
      );
    },
  };
}

export function createInMemoryFailedOperationStore(
  initialRecords: FailedOperationRecord[] = [],
): FailedOperationStore & { records: FailedOperationRecord[] } {
  const records = [...initialRecords];

  return {
    records,

    async recordFailure(input) {
      const scopedKey = toScopedKey(input.operationType, input.operationKey);
      const existing = records.find(
        (record) => toScopedKey(record.operationType, record.operationKey) === scopedKey,
      );
      const now = input.failedAt;

      if (existing) {
        const nextPayloadHash = buildPayloadHash(input.requestPayload);
        if (existing.payloadHash !== nextPayloadHash) {
          throw new FailedOperationConflictError(
            'Failed operation key was reused with a conflicting payload',
          );
        }

        existing.targetService = input.targetService;
        existing.route = input.route;
        existing.method = input.method;
        existing.payloadHash = nextPayloadHash;
        existing.requestPayload = input.requestPayload ?? null;
        existing.requestId = input.requestId;
        existing.correlationId = input.correlationId ?? null;
        existing.idempotencyKey = input.idempotencyKey ?? null;
        existing.actionKey = input.actionKey ?? null;
        existing.actorId = input.actorId ?? null;
        existing.actorUserId = input.actorUserId ?? null;
        existing.actorWalletAddress = input.actorWalletAddress ?? null;
        existing.actorRole = input.actorRole ?? null;
        existing.sessionReference = input.sessionReference ?? null;
        existing.replayEligible = input.replayEligible;
        existing.failureState = 'open';
        existing.lastFailedAt = now;
        existing.retryCount += 1;
        existing.terminalErrorClass = input.terminalErrorClass;
        existing.terminalErrorCode = input.terminalErrorCode;
        existing.terminalErrorMessage = input.terminalErrorMessage;
        existing.metadata = input.metadata ?? {};
        existing.updatedAt = now;
        return { ...existing, metadata: { ...existing.metadata } };
      }

      const record: FailedOperationRecord = {
        failedOperationId: `failed-op-${records.length + 1}`,
        operationType: input.operationType,
        operationKey: input.operationKey,
        targetService: input.targetService,
        route: input.route,
        method: input.method,
        payloadHash: buildPayloadHash(input.requestPayload),
        requestPayload: input.requestPayload ?? null,
        requestId: input.requestId,
        correlationId: input.correlationId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        actionKey: input.actionKey ?? null,
        actorId: input.actorId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorWalletAddress: input.actorWalletAddress ?? null,
        actorRole: input.actorRole ?? null,
        sessionReference: input.sessionReference ?? null,
        replayEligible: input.replayEligible,
        failureState: 'open',
        firstFailedAt: now,
        lastFailedAt: now,
        retryCount: 1,
        terminalErrorClass: input.terminalErrorClass,
        terminalErrorCode: input.terminalErrorCode,
        terminalErrorMessage: input.terminalErrorMessage,
        metadata: input.metadata ?? {},
        lastReplayedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      return { ...record, metadata: { ...record.metadata } };
    },

    async get(failedOperationId) {
      const record = records.find((entry) => entry.failedOperationId === failedOperationId);
      return record ? { ...record, metadata: { ...record.metadata } } : null;
    },

    async list(input = {}) {
      return records
        .filter((record) =>
          input.failureState ? record.failureState === input.failureState : true,
        )
        .filter((record) =>
          input.replayEligible !== undefined
            ? record.replayEligible === input.replayEligible
            : true,
        )
        .sort((left, right) => right.lastFailedAt.localeCompare(left.lastFailedAt))
        .map((record) => ({ ...record, metadata: { ...record.metadata } }));
    },

    async markReplayed(failedOperationId, replayedAt, metadata = {}) {
      const record = records.find((entry) => entry.failedOperationId === failedOperationId);
      if (!record) {
        return;
      }

      record.failureState = 'replayed';
      record.lastReplayedAt = replayedAt;
      record.metadata = {
        ...record.metadata,
        ...metadata,
      };
      record.updatedAt = replayedAt;
    },

    async markReplayFailed(failedOperationId, replayedAt, failure, metadata = {}) {
      const record = records.find((entry) => entry.failedOperationId === failedOperationId);
      if (!record) {
        return;
      }

      record.failureState = 'replay_failed';
      record.lastReplayedAt = replayedAt;
      record.terminalErrorClass = failure.terminalErrorClass;
      record.terminalErrorCode = failure.terminalErrorCode;
      record.terminalErrorMessage = failure.terminalErrorMessage;
      record.metadata = {
        ...record.metadata,
        ...metadata,
      };
      record.updatedAt = replayedAt;
    },
  };
}
