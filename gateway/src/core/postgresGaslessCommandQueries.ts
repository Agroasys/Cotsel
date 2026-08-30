/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { GaslessCommandCapacityError } from './gaslessCommandStore';
import type {
  CreateGaslessCommandInput,
  GaslessCommandRecord,
  GaslessCommandResourceType,
  GaslessCommandStatus,
} from './gaslessCommandStore';

export interface GaslessCommandRow {
  commandId: string;
  applicationRequestId: string;
  intentKey: string;
  resourceType: GaslessCommandResourceType;
  resourceId: string;
  operation: string;
  payload: Record<string, unknown>;
  status: GaslessCommandStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  transactionHash: string | null;
  result: unknown | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const GASLESS_COMMAND_COLUMNS = `
  command_id AS "commandId",
  application_request_id AS "applicationRequestId",
  intent_key AS "intentKey",
  resource_type AS "resourceType",
  resource_id AS "resourceId",
  operation,
  payload,
  status,
  attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts",
  next_attempt_at AS "nextAttemptAt",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  transaction_hash AS "transactionHash",
  result,
  last_error_code AS "lastErrorCode",
  last_error_detail AS "lastErrorDetail",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export function mapGaslessCommand(row: GaslessCommandRow): GaslessCommandRecord {
  return {
    ...row,
    payload: row.payload || {},
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createGaslessCommandWithClient(
  client: PoolClient,
  input: CreateGaslessCommandInput,
): Promise<GaslessCommandRecord> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('gasless-command-capacity'))`);
  const existingResult = await client.query<GaslessCommandRow>(
    `SELECT ${GASLESS_COMMAND_COLUMNS}
     FROM gasless_commands
     WHERE application_request_id = $1 OR intent_key = $2
     ORDER BY created_at ASC
     LIMIT 2`,
    [input.applicationRequestId, input.intentKey],
  );
  if (existingResult.rows.length > 0) {
    if (existingResult.rows.length !== 1) {
      throw new Error('Conflicting gasless command identities require operator review');
    }
    const existing = existingResult.rows[0];
    if (
      existing.intentKey !== input.intentKey ||
      existing.resourceType !== input.resourceType ||
      existing.resourceId !== input.resourceId ||
      existing.operation !== input.operation
    ) {
      throw new Error('Gasless command identity is already bound to a different financial intent');
    }
    return mapGaslessCommand(existing);
  }
  const capacity = await client.query<{ activeCount: string }>(
    `SELECT COUNT(*)::text AS "activeCount"
     FROM gasless_commands
     WHERE status IN ('pending', 'leased', 'outcome_pending')`,
  );
  if (Number(capacity.rows[0]?.activeCount ?? 0) >= input.maxQueueDepth) {
    throw new GaslessCommandCapacityError(input.maxQueueDepth);
  }
  const result = await client.query<GaslessCommandRow>(
    `INSERT INTO gasless_commands (
       command_id, application_request_id, intent_key, resource_type, resource_id,
       operation, payload, status, max_attempts, next_attempt_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING ${GASLESS_COMMAND_COLUMNS}`,
    [
      randomUUID(),
      input.applicationRequestId,
      input.intentKey,
      input.resourceType,
      input.resourceId,
      input.operation,
      JSON.stringify(input.payload),
      input.maxAttempts,
      input.nextAttemptAt,
    ],
  );
  const inserted = result.rows[0];
  if (inserted) return mapGaslessCommand(inserted);
  throw new Error('Gasless command insert lost its serialized capacity lock');
}
