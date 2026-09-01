/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { CreateGaslessCommandInput } from '../src/core/gaslessCommandStore';
import {
  buildRequestFingerprint,
  createPostgresIdempotencyStore,
} from '../src/core/idempotencyStore';
import {
  createGaslessCommandWithClient,
  createPostgresGaslessCommandStore,
} from '../src/core/postgresGaslessCommandStore';
import { SettlementService } from '../src/core/settlementService';
import { createPostgresSettlementStore } from '../src/core/settlementStore';
import { runMigrations } from '../src/database/migrations';
import { baseTestGatewayConfig } from './support/testConfig';

const databaseUrl = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const testPrefix = `command-store-test-${randomUUID()}`;

describeWithPostgres('Postgres gasless command store', () => {
  let pool: Pool;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!parsed.pathname.toLowerCase().includes('test')) {
      throw new Error('Gasless command integration tests require a dedicated test database');
    }
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
    await pool.query(
      `DELETE FROM gasless_command_attempts
       WHERE command_id IN (
         SELECT command_id FROM gasless_commands
         WHERE application_request_id LIKE 'command-store-test-%'
       )`,
    );
    await pool.query(
      "DELETE FROM gasless_commands WHERE application_request_id LIKE 'command-store-test-%'",
    );
  });

  afterEach(async () => {
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
    await pool.query('DELETE FROM settlement_callback_deliveries WHERE request_id LIKE $1', [
      `${testPrefix}%`,
    ]);
    await pool.query('DELETE FROM settlement_execution_events WHERE request_id LIKE $1', [
      `${testPrefix}%`,
    ]);
    await pool.query('DELETE FROM settlement_handoffs WHERE platform_handoff_id LIKE $1', [
      `${testPrefix}%`,
    ]);
    await pool.query('DELETE FROM idempotency_keys WHERE idempotency_key LIKE $1', [
      `${testPrefix}%`,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  function commandInput(suffix: string, maxAttempts = 3): CreateGaslessCommandInput {
    return {
      applicationRequestId: `${testPrefix}-${suffix}`,
      intentKey: createHash('sha256').update(`${testPrefix}-${suffix}`).digest('hex'),
      resourceType: 'settlement_handoff',
      resourceId: `handoff-${suffix}`,
      operation: 'create_trade',
      payload: { action: 'create_trade', handoffId: `handoff-${suffix}` },
      maxAttempts,
      maxQueueDepth: 100,
      nextAttemptAt: '2026-08-29T00:00:00.000Z',
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

  test('deduplicates the same financial intent and rejects a conflicting binding', async () => {
    const input = commandInput('identity');
    const first = await enqueue(input);
    const duplicate = await enqueue(input);

    expect(duplicate.commandId).toBe(first.commandId);
    await expect(
      enqueue({
        ...input,
        intentKey: 'f'.repeat(64),
        resourceId: 'different-handoff',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: {
        applicationRequestId: input.applicationRequestId,
        reason: 'intent_mismatch',
      },
    });
  });

  test('deduplicates concurrent enqueue of the same financial intent', async () => {
    const input = commandInput('concurrent-identity');
    const [first, second] = await Promise.all([enqueue(input), enqueue(input)]);

    expect(second.commandId).toBe(first.commandId);
    const persisted = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM gasless_commands WHERE application_request_id = $1',
      [input.applicationRequestId],
    );
    expect(persisted.rows[0]?.count).toBe('1');
  });

  test('returns a conflict when request and intent identities resolve to different commands', async () => {
    const requestIdentity = commandInput('ambiguous-request');
    const intentIdentity = commandInput('ambiguous-intent');
    await enqueue(requestIdentity);
    await enqueue(intentIdentity);

    await expect(
      enqueue({
        ...requestIdentity,
        intentKey: intentIdentity.intentKey,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: {
        applicationRequestId: requestIdentity.applicationRequestId,
        reason: 'ambiguous_identity',
      },
    });
  });

  test('rejects intake when the visible queue depth already reaches the soft limit', async () => {
    const first = { ...commandInput('capacity-a'), maxQueueDepth: 1 };
    const second = { ...commandInput('capacity-b'), maxQueueDepth: 1 };
    await enqueue(first);

    await expect(enqueue(second)).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  test('commits acceptance, callback, and command atomically', async () => {
    const settlementStore = createPostgresSettlementStore(pool);
    const settlementService = new SettlementService(baseTestGatewayConfig, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: `${testPrefix}-atomic-success`,
      tradeId: `${testPrefix}-trade-success`,
      phase: 'funding',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 100,
      requestId: `${testPrefix}-handoff-success`,
    });
    const command = commandInput('atomic-success');
    const accepted = await settlementService.recordExecutionEvent(
      {
        handoffId: handoff.handoffId,
        eventType: 'accepted',
        executionStatus: 'accepted',
        reconciliationStatus: 'pending',
        providerStatus: 'gasless_request_accepted',
        observedAt: '2026-08-29T00:00:00.000Z',
        requestId: command.applicationRequestId,
      },
      { ...command, resourceId: handoff.handoffId },
    );

    expect(accepted.command).toMatchObject({
      applicationRequestId: command.applicationRequestId,
      resourceId: handoff.handoffId,
      status: 'pending',
    });
    const counts = await pool.query<{
      eventCount: string;
      callbackCount: string;
      commandCount: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM settlement_execution_events WHERE handoff_id = $1)::text AS "eventCount",
         (SELECT COUNT(*) FROM settlement_callback_deliveries WHERE handoff_id = $1)::text AS "callbackCount",
         (SELECT COUNT(*) FROM gasless_commands WHERE resource_id = $1)::text AS "commandCount"`,
      [handoff.handoffId],
    );
    expect(counts.rows[0]).toEqual({ eventCount: '1', callbackCount: '1', commandCount: '1' });
  });

  test('rolls back acceptance when command persistence fails', async () => {
    const settlementStore = createPostgresSettlementStore(pool);
    const settlementService = new SettlementService(baseTestGatewayConfig, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: `${testPrefix}-atomic-rollback`,
      tradeId: `${testPrefix}-trade-rollback`,
      phase: 'funding',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 100,
      requestId: `${testPrefix}-handoff-rollback`,
    });
    const command = commandInput('atomic-rollback');
    await expect(
      settlementService.recordExecutionEvent(
        {
          handoffId: handoff.handoffId,
          eventType: 'accepted',
          executionStatus: 'accepted',
          reconciliationStatus: 'pending',
          providerStatus: 'gasless_request_accepted',
          observedAt: '2026-08-29T00:00:00.000Z',
          requestId: command.applicationRequestId,
        },
        { ...command, intentKey: 'not-a-valid-intent-key', resourceId: handoff.handoffId },
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const unchanged = await settlementStore.getHandoff(handoff.handoffId);
    expect(unchanged).toMatchObject({
      executionStatus: 'pending',
      latestEventId: null,
      callbackStatus: 'pending',
    });
    const counts = await pool.query<{ events: string; callbacks: string; commands: string }>(
      `SELECT
         (SELECT COUNT(*) FROM settlement_execution_events WHERE handoff_id = $1)::text AS events,
         (SELECT COUNT(*) FROM settlement_callback_deliveries WHERE handoff_id = $1)::text AS callbacks,
         (SELECT COUNT(*) FROM gasless_commands WHERE resource_id = $1)::text AS commands`,
      [handoff.handoffId],
    );
    expect(counts.rows[0]).toEqual({ events: '0', callbacks: '0', commands: '0' });
  });

  test('gives one worker the lease and fences stale completion', async () => {
    const command = await enqueue(commandInput('concurrent-claim'));
    const store = createPostgresGaslessCommandStore(pool);
    const claims = await Promise.all([
      store.claimDueCommand('worker-a', '2026-08-29T00:00:01.000Z', '2026-08-29T00:00:31.000Z'),
      store.claimDueCommand('worker-b', '2026-08-29T00:00:01.000Z', '2026-08-29T00:00:31.000Z'),
    ]);
    const claimed = claims.filter((candidate) => candidate !== null);
    expect(claimed).toHaveLength(1);
    const winner = claimed[0]!;
    const staleOwner = winner.leaseOwner === 'worker-a' ? 'worker-b' : 'worker-a';

    await expect(
      store.markCompleted(command.commandId, staleOwner, '2026-08-29T00:00:02.000Z', {
        invalid: true,
      }),
    ).resolves.toBe(false);
    await expect(
      store.markCompleted(
        command.commandId,
        winner.leaseOwner!,
        '2026-08-29T00:00:03.000Z',
        { ok: true },
        `0x${'1'.repeat(64)}`,
      ),
    ).resolves.toBe(true);
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'completed',
      attemptCount: 1,
      leaseOwner: null,
    });
  });

  test('records an expired lease before a replacement retries the command', async () => {
    const command = await enqueue(commandInput('expired-lease'));
    const store = createPostgresGaslessCommandStore(pool);
    await store.claimDueCommand(
      'crashed-worker',
      '2026-08-29T00:01:00.000Z',
      '2026-08-29T00:01:30.000Z',
    );
    const replacement = await store.claimDueCommand(
      'replacement-worker',
      '2026-08-29T00:01:30.000Z',
      '2026-08-29T00:02:00.000Z',
    );

    expect(replacement).toMatchObject({ commandId: command.commandId, attemptCount: 2 });
    await expect(
      store.markFailed(
        command.commandId,
        'replacement-worker',
        '2026-08-29T00:01:31.000Z',
        'RPC_TIMEOUT',
        'Provider timed out before signing',
        '2026-08-29T00:01:40.000Z',
        false,
      ),
    ).resolves.toBe(true);
    const attempts = await pool.query<{ attemptNumber: number; outcome: string }>(
      `SELECT attempt_number AS "attemptNumber", outcome
       FROM gasless_command_attempts
       WHERE command_id = $1
       ORDER BY attempt_number`,
      [command.commandId],
    );
    expect(attempts.rows).toEqual([
      { attemptNumber: 1, outcome: 'lease_expired' },
      { attemptNumber: 2, outcome: 'retry_scheduled' },
    ]);
  });

  test('resolves an externally observed outcome while fencing an abandoned lease', async () => {
    const command = await enqueue(commandInput('external-outcome'));
    const store = createPostgresGaslessCommandStore(pool);
    await store.claimDueCommand(
      'crashed-after-broadcast',
      '2026-08-29T00:02:00.000Z',
      '2026-08-29T00:02:30.000Z',
    );

    await expect(
      store.resolveTransactionOutcome(
        command.applicationRequestId,
        `0x${'2'.repeat(64)}`,
        'confirmed',
        '2026-08-29T00:02:10.000Z',
      ),
    ).resolves.toBe(true);
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'completed',
      leaseOwner: null,
      leaseExpiresAt: null,
      transactionHash: `0x${'2'.repeat(64)}`,
    });
    const attempt = await pool.query<{ outcome: string; finishedAt: Date | null }>(
      `SELECT outcome, finished_at AS "finishedAt"
       FROM gasless_command_attempts
       WHERE command_id = $1`,
      [command.commandId],
    );
    expect(attempt.rows[0]).toMatchObject({
      outcome: 'outcome_resolved',
      finishedAt: expect.any(Date),
    });
  });

  test('recovers an observed transaction after a final attempt lease expires', async () => {
    const command = await enqueue(commandInput('final-attempt-crash', 1));
    const store = createPostgresGaslessCommandStore(pool);
    await store.claimDueCommand(
      'final-worker',
      '2026-08-29T00:03:00.000Z',
      '2026-08-29T00:03:30.000Z',
    );
    await expect(
      store.claimDueCommand('scanner', '2026-08-29T00:03:30.000Z', '2026-08-29T00:04:00.000Z'),
    ).resolves.toBeNull();
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'dead_letter',
      lastErrorCode: 'LEASE_ATTEMPTS_EXHAUSTED',
    });

    const transactionHash = `0x${'3'.repeat(64)}`;
    await expect(
      store.resolveTransactionOutcome(
        command.applicationRequestId,
        transactionHash,
        'confirmed',
        '2026-08-29T00:03:40.000Z',
      ),
    ).resolves.toBe(true);
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'completed',
      transactionHash,
      lastErrorCode: null,
      lastErrorDetail: null,
      result: {
        outcomeStatus: 'confirmed',
        rebroadcastAllowed: false,
        recovered: true,
      },
    });
  });

  test('does not reclaim or release an idempotency key that owns a durable command', async () => {
    const store = createPostgresIdempotencyStore(pool, 1_000);
    const requestPath = '/api/dashboard-gateway/v1/settlements/gasless';
    const scope = {
      actorId: 'operator-command-test',
      endpoint: `POST ${requestPath}`,
      idempotencyKey: `${testPrefix}-idempotency-fence`,
    };
    const requestFingerprint = buildRequestFingerprint(
      'POST',
      requestPath,
      Buffer.from('{"durable":true}'),
    );
    const firstRequestId = `${testPrefix}-idempotency-original`;
    const first = await store.createPending({
      ...scope,
      requestMethod: 'POST',
      requestPath,
      requestFingerprint,
      requestId: firstRequestId,
    });
    expect(first.created).toBe(true);
    await enqueue({
      ...commandInput('idempotency-command'),
      applicationRequestId: firstRequestId,
    });
    await pool.query(
      `UPDATE idempotency_keys
       SET lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE actor_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [scope.actorId, scope.endpoint, scope.idempotencyKey],
    );

    const reclaimed = await store.createPending({
      ...scope,
      requestMethod: 'POST',
      requestPath,
      requestFingerprint,
      requestId: `${testPrefix}-idempotency-retry`,
    });
    expect(reclaimed).toMatchObject({ created: false });
    expect(reclaimed.record.requestId).toBe(firstRequestId);

    await store.releasePending(scope, firstRequestId);
    await expect(store.get(scope)).resolves.toMatchObject({ requestId: firstRequestId });
  });
});
