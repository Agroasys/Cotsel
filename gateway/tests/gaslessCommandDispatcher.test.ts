/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../src/errors';
import { GaslessCommandDispatcher } from '../src/core/gaslessCommandDispatcher';
import type { CreateGaslessCommandInput } from '../src/core/gaslessCommandStore';
import { createInMemoryGaslessCommandStore } from '../src/core/inMemoryGaslessCommandStore';
import {
  GaslessPersistedOutcomeError,
  GaslessTransactionOutcomePendingError,
} from '../src/core/gaslessTransactionLifecycle';

const TX_HASH = `0x${'a'.repeat(64)}`;

function commandInput(suffix: string, maxAttempts = 3): CreateGaslessCommandInput {
  return {
    applicationRequestId: `request-${suffix}`,
    intentKey: suffix.padEnd(64, '0').slice(0, 64),
    resourceType: 'platform_transfer',
    resourceId: `transfer-${suffix}`,
    operation: 'wallet_usdc_transfer',
    payload: { requestId: `request-${suffix}` },
    maxAttempts,
    maxQueueDepth: 10,
    nextAttemptAt: new Date().toISOString(),
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    leaseMs: 3_000,
    pollIntervalMs: 10_000,
    retryInitialMs: 5,
    retryMaxMs: 10,
    waitTimeoutMs: 500,
    maxBatch: 10,
    ...overrides,
  };
}

describe('durable gasless command dispatcher', () => {
  test('retries a transient pre-broadcast failure and completes the same command', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('retry'));
    let attempts = 0;
    const dispatcher = new GaslessCommandDispatcher(
      store,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ECONNREFUSED');
        return { result: { txHash: TX_HASH }, transactionHash: TX_HASH };
      },
      options(),
    );

    await expect(dispatcher.executeAndWait(command.commandId)).resolves.toEqual({
      txHash: TX_HASH,
    });
    expect(attempts).toBe(2);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'completed',
      attemptCount: 2,
      transactionHash: TX_HASH,
    });
  });

  test('dead-letters deterministic validation failures without retrying', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('invalid'));
    const terminal = jest.fn(async () => undefined);
    const processor = jest.fn(async () => {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid accepted command');
    });
    const dispatcher = new GaslessCommandDispatcher(
      store,
      processor,
      options({
        onTerminalFailure: terminal,
      }),
    );

    await expect(dispatcher.executeAndWait(command.commandId)).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
      lastErrorCode: 'VALIDATION_ERROR',
    });
  });

  test('redacts authenticated URLs and secret-shaped values from durable failure details', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('redacted-failure', 1));
    const dispatcher = new GaslessCommandDispatcher(
      store,
      async () => {
        throw new Error(
          `RPC failed at https://user:password@rpc.example.test/path?apiKey=sensitive ` +
            `token=sensitive private=${'f'.repeat(64)}`,
        );
      },
      options(),
    );

    await expect(dispatcher.executeAndWait(command.commandId)).rejects.toMatchObject({
      statusCode: 503,
    });
    const failed = await store.getCommand(command.commandId);
    expect(failed?.lastErrorDetail).toContain('https://rpc.example.test');
    expect(failed?.lastErrorDetail).toContain('token=[REDACTED]');
    expect(failed?.lastErrorDetail).toContain('[REDACTED_32_BYTE_VALUE]');
    expect(failed?.lastErrorDetail).not.toContain('sensitive');
    expect(failed?.lastErrorDetail).not.toContain('user:password');
  });

  test('lists dead letters without payloads and grants exactly one controlled redrive attempt', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('operator-redrive', 1));
    const firstDispatcher = new GaslessCommandDispatcher(
      store,
      async () => {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Rejected before broadcast');
      },
      options(),
    );
    await expect(firstDispatcher.executeAndWait(command.commandId)).rejects.toMatchObject({
      statusCode: 503,
    });

    const deadLetters = await store.listDeadLetters(100);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      commandId: command.commandId,
      status: 'dead_letter',
      attemptCount: 1,
      maxAttempts: 1,
    });
    expect(deadLetters[0]).not.toHaveProperty('payload');
    expect(deadLetters[0]).not.toHaveProperty('result');

    await expect(
      store.redriveDeadLetter(command.commandId, new Date().toISOString(), {
        eventType: 'gateway.gasless_command.redriven',
        route: '/test/redrive',
        method: 'POST',
        requestId: 'redrive-outcome-owned-command',
        actionId: command.commandId,
        status: 'queued',
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      attemptCount: 1,
      maxAttempts: 2,
      lastErrorCode: null,
    });
    const processor = jest.fn(async () => ({
      result: { txHash: TX_HASH },
      transactionHash: TX_HASH,
    }));
    const secondDispatcher = new GaslessCommandDispatcher(store, processor, options());
    await expect(secondDispatcher.executeAndWait(command.commandId)).resolves.toEqual({
      txHash: TX_HASH,
    });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'completed',
      attemptCount: 2,
      maxAttempts: 2,
      transactionHash: TX_HASH,
    });
  });

  test('holds an unknown broadcast outcome without retry or rebroadcast', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('unknown'));
    const processor = jest.fn(async () => {
      throw new GaslessTransactionOutcomePendingError(
        TX_HASH,
        'broadcast_unknown',
        'Broadcast outcome is unknown',
      );
    });
    const dispatcher = new GaslessCommandDispatcher(store, processor, options());

    await expect(dispatcher.executeAndWait(command.commandId)).rejects.toMatchObject({
      details: expect.objectContaining({ rebroadcastAllowed: false }),
    });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'outcome_pending',
      attemptCount: 1,
      transactionHash: TX_HASH,
    });
  });

  test('projects an already confirmed persisted outcome without executing again', async () => {
    const store = createInMemoryGaslessCommandStore();
    const command = await store.enqueueCommand(commandInput('confirmed'));
    const processor = jest.fn(async () => {
      throw new GaslessPersistedOutcomeError(TX_HASH, 'confirmed');
    });
    const dispatcher = new GaslessCommandDispatcher(store, processor, options());

    await expect(dispatcher.executeAndWait(command.commandId)).resolves.toMatchObject({
      transactionHash: TX_HASH,
      outcomeStatus: 'confirmed',
      recovered: true,
      rebroadcastAllowed: false,
    });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'completed',
      transactionHash: TX_HASH,
    });
  });

  test('reclaims an expired lease after a worker crash and fences the stale owner', async () => {
    const store = createInMemoryGaslessCommandStore();
    const attemptedAt = new Date(Date.now() - 10_000);
    const input = commandInput('crash');
    input.nextAttemptAt = attemptedAt.toISOString();
    const command = await store.enqueueCommand(input);
    const crashed = await store.claimDueCommand(
      'crashed-worker',
      attemptedAt.toISOString(),
      new Date(attemptedAt.getTime() + 3_000).toISOString(),
    );
    expect(crashed).not.toBeNull();
    const dispatcher = new GaslessCommandDispatcher(
      store,
      async () => ({ result: { txHash: TX_HASH }, transactionHash: TX_HASH }),
      options(),
    );

    await expect(dispatcher.executeAndWait(command.commandId)).resolves.toEqual({
      txHash: TX_HASH,
    });
    await expect(
      store.markCompleted(command.commandId, 'crashed-worker', new Date().toISOString(), {
        txHash: `0x${'b'.repeat(64)}`,
      }),
    ).resolves.toBe(false);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'completed',
      attemptCount: 2,
      transactionHash: TX_HASH,
    });
  });

  test('resolves chain evidence after a final lease expires without rebroadcasting', async () => {
    const store = createInMemoryGaslessCommandStore();
    const attemptedAt = new Date(Date.now() - 10_000);
    const input = commandInput('late-chain-outcome', 1);
    input.nextAttemptAt = attemptedAt.toISOString();
    const command = await store.enqueueCommand(input);
    await store.claimDueCommand(
      'crashed-final-worker',
      attemptedAt.toISOString(),
      new Date(attemptedAt.getTime() + 3_000).toISOString(),
    );
    await store.claimDueCommand(
      'lease-scanner',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'dead_letter',
      lastErrorCode: 'LEASE_ATTEMPTS_EXHAUSTED',
    });

    await expect(
      store.resolveTransactionOutcome(
        command.applicationRequestId,
        TX_HASH,
        'confirmed',
        new Date().toISOString(),
      ),
    ).resolves.toBe(true);
    expect(await store.getCommand(command.commandId)).toMatchObject({
      status: 'completed',
      transactionHash: TX_HASH,
      lastErrorCode: null,
      lastErrorDetail: null,
      result: expect.objectContaining({ rebroadcastAllowed: false }),
    });
  });
});
