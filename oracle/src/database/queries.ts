import { pool } from './connection';
import { Logger } from '../utils/logger';
import { Trigger, CreateTriggerData, UpdateTriggerData, TriggerStatus } from '../types/trigger';
import { getErrorMessage } from '../utils/errors';

export async function createTrigger(data: CreateTriggerData): Promise<Trigger> {
  try {
    const result = await pool.query(
      `INSERT INTO oracle_triggers
            (action_key, request_id, idempotency_key, trade_id, trigger_type, request_hash, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *`,
      [
        data.actionKey,
        data.requestId,
        data.idempotencyKey,
        data.tradeId,
        data.triggerType,
        data.requestHash,
        data.status || TriggerStatus.PENDING,
      ],
    );

    Logger.info('Trigger created', {
      actionKey: data.actionKey,
      requestId: data.requestId.substring(0, 16),
      tradeId: data.tradeId,
      type: data.triggerType,
    });

    return result.rows[0];
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      const existing = await getLatestTriggerByActionKey(data.actionKey);
      if (existing) {
        Logger.warn('Concurrent trigger create detected, reusing latest trigger', {
          actionKey: data.actionKey,
          requestId: data.requestId.substring(0, 16),
          existingRequestId: existing.request_id.substring(0, 16),
        });
        return existing;
      }
    }

    Logger.error('Failed to create trigger', error);
    throw error;
  }
}

export async function getTriggerByIdempotencyKey(idempotencyKey: string): Promise<Trigger | null> {
  const result = await pool.query('SELECT * FROM oracle_triggers WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return result.rows[0] || null;
}

export async function getTriggersByActionKey(actionKey: string): Promise<Trigger[]> {
  const result = await pool.query(
    'SELECT * FROM oracle_triggers WHERE action_key = $1 ORDER BY created_at DESC',
    [actionKey],
  );
  return result.rows;
}

export async function getLatestTriggerByActionKey(actionKey: string): Promise<Trigger | null> {
  const result = await pool.query(
    'SELECT * FROM oracle_triggers WHERE action_key = $1 ORDER BY created_at DESC LIMIT 1',
    [actionKey],
  );
  return result.rows[0] || null;
}

export async function getTriggersByTradeId(tradeId: string): Promise<Trigger[]> {
  const result = await pool.query(
    'SELECT * FROM oracle_triggers WHERE trade_id = $1 ORDER BY created_at DESC',
    [tradeId],
  );
  return result.rows;
}

export async function getTriggersByStatus(
  status: TriggerStatus,
  limit: number = 100,
): Promise<Trigger[]> {
  const result = await pool.query(
    'SELECT * FROM oracle_triggers WHERE status = $1 ORDER BY created_at ASC LIMIT $2',
    [status, limit],
  );
  return result.rows;
}

export async function getExhaustedTriggersForRedrive(limit: number = 50): Promise<Trigger[]> {
  const result = await pool.query(
    `SELECT * FROM oracle_triggers
         WHERE status = $1
         ORDER BY updated_at ASC
         LIMIT $2`,
    [TriggerStatus.EXHAUSTED_NEEDS_REDRIVE, limit],
  );
  return result.rows;
}

export async function consumeHmacNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await pool.query<{ accepted: boolean }>(
    `WITH pruned_nonce AS (
            DELETE FROM oracle_hmac_nonces
            WHERE expires_at <= NOW()
        ),
        consumed_nonce AS (
            INSERT INTO oracle_hmac_nonces (api_key, nonce, expires_at)
            VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))
            ON CONFLICT (api_key, nonce) DO NOTHING
            RETURNING 1
        )
        SELECT EXISTS(SELECT 1 FROM consumed_nonce) AS accepted`,
    [apiKey, nonce, ttlSeconds],
  );

  return Boolean(result.rows[0]?.accepted);
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  'status',
  'attempt_count',
  'tx_hash',
  'block_number',
  'confirmation_stage',
  'confirmation_stage_at',
  'indexer_confirmed',
  'indexer_confirmed_at',
  'indexer_event_id',
  'last_error',
  'error_type',
  'submitted_at',
  'confirmed_at',
  'on_chain_verified',
  'on_chain_verified_at',
  'approved_by',
  'approved_at',
  'rejected_by',
  'rejected_at',
  'rejection_reason',
]);

export async function updateTrigger(
  idempotencyKey: string,
  updates: UpdateTriggerData,
): Promise<void> {
  const fields: string[] = [];
  const values: Array<UpdateTriggerData[keyof UpdateTriggerData] | string> = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
        Logger.warn('Attempted to update non-whitelisted column', {
          column: key,
          idempotencyKey: idempotencyKey.substring(0, 16),
        });
        continue;
      }

      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (fields.length === 0) {
    Logger.warn('No valid fields to update', { idempotencyKey: idempotencyKey.substring(0, 16) });
    return;
  }

  fields.push('updated_at = NOW()');
  values.push(idempotencyKey);

  const query = `
        UPDATE oracle_triggers 
        SET ${fields.join(', ')} 
        WHERE idempotency_key = $${paramIndex}
    `;

  try {
    await pool.query(query, values);
  } catch (error: unknown) {
    Logger.error('Failed to update trigger', {
      idempotencyKey: idempotencyKey.substring(0, 16),
      error: getErrorMessage(error),
    });
    throw error;
  }

  Logger.info('Trigger updated', {
    idempotencyKey: idempotencyKey.substring(0, 16),
    fields: Object.keys(updates).filter((k) => ALLOWED_UPDATE_COLUMNS.has(k)),
  });
}

export async function approveTrigger(
  idempotencyKey: string,
  actor: string,
): Promise<Trigger | null> {
  const result = await pool.query(
    `UPDATE oracle_triggers
         SET status = $1,
             approved_by = $2,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE idempotency_key = $3
           AND status = $4
         RETURNING *`,
    [TriggerStatus.PENDING, actor, idempotencyKey, TriggerStatus.PENDING_APPROVAL],
  );
  return result.rows[0] || null;
}

export async function rejectTrigger(
  idempotencyKey: string,
  actor: string,
  reason?: string,
): Promise<Trigger | null> {
  const result = await pool.query(
    `UPDATE oracle_triggers
         SET status = $1,
             rejected_by = $2,
             rejected_at = NOW(),
             rejection_reason = $3,
             updated_at = NOW()
         WHERE idempotency_key = $4
           AND status = $5
         RETURNING *`,
    [TriggerStatus.REJECTED, actor, reason ?? null, idempotencyKey, TriggerStatus.PENDING_APPROVAL],
  );
  return result.rows[0] || null;
}
