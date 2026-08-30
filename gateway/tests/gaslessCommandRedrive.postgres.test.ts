/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { CreateGaslessCommandInput } from '../src/core/gaslessCommandStore';
import {
  createGaslessCommandWithClient,
  createPostgresGaslessCommandStore,
} from '../src/core/postgresGaslessCommandStore';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
import { runMigrations } from '../src/database/migrations';
import type { AuditLogEntry } from '../src/core/auditLogStore';

const databaseUrl = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const testPrefix = `command-redrive-test-${randomUUID()}`;

describeWithPostgres('Postgres gasless command redrive', () => {
  let pool: Pool;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!parsed.pathname.toLowerCase().includes('test')) {
      throw new Error('Gasless command redrive tests require a dedicated test database');
    }
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM audit_log WHERE request_id LIKE $1', [`${testPrefix}%`]);
    await pool.query(
      `DELETE FROM gasless_transaction_outcome_events
       WHERE transaction_hash IN (
         SELECT transaction_hash FROM gasless_transaction_outcomes
         WHERE application_request_id LIKE $1
       )`,
      [`${testPrefix}%`],
    );
    await pool.query(
      'DELETE FROM gasless_transaction_outcomes WHERE application_request_id LIKE $1',
      [`${testPrefix}%`],
    );
    await pool.query(
      `DELETE FROM gasless_command_attempts
       WHERE command_id IN (
         SELECT command_id FROM gasless_commands WHERE application_request_id LIKE $1
       )`,
      [`${testPrefix}%`],
    );
    await pool.query('DELETE FROM gasless_commands WHERE application_request_id LIKE $1', [
      `${testPrefix}%`,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  function commandInput(suffix: string): CreateGaslessCommandInput {
    return {
      applicationRequestId: `${testPrefix}-${suffix}`,
      intentKey: createHash('sha256').update(`${testPrefix}-${suffix}`).digest('hex'),
      resourceType: 'settlement_handoff',
      resourceId: `handoff-${suffix}`,
      operation: 'create_trade',
      payload: { action: 'create_trade', handoffId: `handoff-${suffix}` },
      maxAttempts: 1,
      maxQueueDepth: 100,
      nextAttemptAt: '2026-08-29T00:00:00.000Z',
    };
  }

  function redriveAudit(commandId: string, suffix: string): AuditLogEntry {
    return {
      eventType: 'gateway.gasless_command.redriven',
      route: '/operations/gasless-relayer/dead-letters/:commandId/redrive',
      method: 'POST',
      requestId: `${testPrefix}-request-${suffix}`,
      correlationId: `${testPrefix}-correlation-${suffix}`,
      actionId: commandId,
      idempotencyKey: `${testPrefix}-idempotency-${suffix}`,
      actorId: 'user:redrive-test-operator',
      actorUserId: 'redrive-test-operator',
      actorRole: 'admin',
      status: 'queued',
      metadata: { commandId },
    };
  }

  async function enqueue(input: CreateGaslessCommandInput) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const command = await createGaslessCommandWithClient(client, input);
      await client.query('COMMIT');
      return command;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function deadLetter(suffix: string) {
    const command = await enqueue(commandInput(suffix));
    const store = createPostgresGaslessCommandStore(pool);
    await store.claimDueCommand(
      'failed-worker',
      '2026-08-29T00:04:00.000Z',
      '2026-08-29T00:04:30.000Z',
    );
    await store.markFailed(
      command.commandId,
      'failed-worker',
      '2026-08-29T00:04:01.000Z',
      'RPC_UNAVAILABLE',
      'Provider unavailable before signing',
      '2026-08-29T00:04:10.000Z',
      true,
    );
    return { command, store };
  }

  test('lists redacted dead letters and grants one additional attempt', async () => {
    const { command, store } = await deadLetter('controlled-redrive');
    const deadLetters = await store.listDeadLetters(100);
    const exception = deadLetters.find((record) => record.commandId === command.commandId);
    expect(exception).toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
      maxAttempts: 1,
      lastErrorCode: 'RPC_UNAVAILABLE',
    });
    expect(exception).not.toHaveProperty('payload');
    expect(exception).not.toHaveProperty('result');

    await expect(
      store.redriveDeadLetter(
        command.commandId,
        '2026-08-29T00:05:00.000Z',
        redriveAudit(command.commandId, 'controlled-redrive'),
      ),
    ).resolves.toMatchObject({
      status: 'pending',
      attemptCount: 1,
      maxAttempts: 2,
      lastErrorCode: null,
      nextAttemptAt: '2026-08-29T00:05:00.000Z',
    });
    await expect(
      store.redriveDeadLetter(
        command.commandId,
        '2026-08-29T00:05:01.000Z',
        redriveAudit(command.commandId, 'duplicate-redrive'),
      ),
    ).resolves.toBeNull();
    const auditRows = await pool.query(
      `SELECT event_type, request_id, action_id, idempotency_key, actor_id, status
       FROM audit_log
       WHERE action_id = $1`,
      [command.commandId],
    );
    expect(auditRows.rows).toEqual([
      {
        event_type: 'gateway.gasless_command.redriven',
        request_id: `${testPrefix}-request-controlled-redrive`,
        action_id: command.commandId,
        idempotency_key: `${testPrefix}-idempotency-controlled-redrive`,
        actor_id: 'user:redrive-test-operator',
        status: 'queued',
      },
    ]);
    await expect(
      store.claimDueCommand(
        'redrive-worker',
        '2026-08-29T00:05:00.000Z',
        '2026-08-29T00:05:30.000Z',
      ),
    ).resolves.toMatchObject({ commandId: command.commandId, attemptCount: 2, maxAttempts: 2 });
  });

  test('refuses redrive when a durable transaction identity exists', async () => {
    const { command, store } = await deadLetter('outcome-fence');
    const outcomeStore = createPostgresGaslessTransactionOutcomeRecorder(pool);
    const transactionHash = `0x${createHash('sha256')
      .update(`${testPrefix}-outcome-fence`)
      .digest('hex')}`;
    await outcomeStore.recordPrepared({
      transactionHash,
      applicationRequestId: command.applicationRequestId,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      operation: command.operation,
      chainId: 84532,
      signerAddress: `0x${'1'.repeat(40)}`,
      nonce: 1,
      transactionType: 2,
      destinationAddress: `0x${'2'.repeat(40)}`,
      valueWei: '0',
      gasLimit: '210000',
      maxFeePerGasWei: '1000000000',
      maxPriorityFeePerGasWei: '100000000',
      gasPriceWei: null,
      calldataHash: `0x${'5'.repeat(64)}`,
      intentHash: `0x${'6'.repeat(64)}`,
    });

    await expect(
      store.redriveDeadLetter(
        command.commandId,
        '2026-08-29T00:07:00.000Z',
        redriveAudit(command.commandId, 'outcome-fence'),
      ),
    ).resolves.toBeNull();
    await expect(
      pool.query('SELECT 1 FROM audit_log WHERE action_id = $1', [command.commandId]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
    });
  });

  test('rolls back redrive when its durable audit record cannot be stored', async () => {
    const { command, store } = await deadLetter('audit-rollback');
    const invalidAudit = redriveAudit(command.commandId, 'audit-rollback');
    invalidAudit.eventType = null as unknown as string;

    await expect(
      store.redriveDeadLetter(command.commandId, '2026-08-29T00:08:00.000Z', invalidAudit),
    ).rejects.toMatchObject({ code: '23502' });
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
      maxAttempts: 1,
      lastErrorCode: 'RPC_UNAVAILABLE',
    });
    await expect(
      pool.query('SELECT 1 FROM audit_log WHERE action_id = $1', [command.commandId]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});
