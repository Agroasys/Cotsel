/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { redactRpcUrlForLogs } from '@agroasys/sdk';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import type {
  GaslessCommandQueueStats,
  GaslessCommandRecord,
  GaslessCommandStore,
} from './gaslessCommandStore';
import {
  isGaslessPersistedOutcomeError,
  isGaslessTransactionOutcomePendingError,
  isGaslessTransactionRevertedError,
} from './gaslessTransactionLifecycle';

export interface GaslessCommandProcessorResult {
  result: unknown;
  transactionHash?: string | null;
}

interface GaslessCommandDispatcherOptions {
  leaseMs: number;
  pollIntervalMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
  waitTimeoutMs: number;
  maxBatch: number;
  now?: () => Date;
  onTerminalFailure?: (command: GaslessCommandRecord, error: unknown) => Promise<void>;
}

function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactRpcUrlForLogs(url))
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)[^\s,;]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[REDACTED_32_BYTE_VALUE]')
    .slice(0, 512);
}

function safeError(error: unknown): { code: string; detail: string; retryable: boolean } {
  if (error instanceof GatewayError) {
    return {
      code: error.code,
      detail: sanitizeErrorDetail(error.message),
      retryable: error.statusCode >= 500,
    };
  }
  if (error instanceof Error) {
    const errorCode =
      'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code)
        : error.name;
    const deterministicCodes = new Set([
      'ACTION_REJECTED',
      'CALL_EXCEPTION',
      'INVALID_ARGUMENT',
      'NUMERIC_FAULT',
      'UNSUPPORTED_OPERATION',
    ]);
    const deterministicMessage = /\b(revert|reverted|invalid argument|insufficient funds)\b/i.test(
      error.message,
    );
    return {
      code: errorCode.slice(0, 128) || 'UNEXPECTED_ERROR',
      detail: sanitizeErrorDetail(error.message),
      retryable: !deterministicCodes.has(errorCode) && !deterministicMessage,
    };
  }
  return { code: 'UNEXPECTED_ERROR', detail: 'Unknown command failure', retryable: true };
}

function transactionHashFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const txHash = (result as Record<string, unknown>).txHash;
  return typeof txHash === 'string' ? txHash : null;
}

export class GaslessCommandDispatcher {
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private drain: Promise<void> | null = null;
  private queueStats: GaslessCommandQueueStats = {
    pending: 0,
    leased: 0,
    outcomePending: 0,
    deadLetter: 0,
    expiredLeases: 0,
    oldestPendingAt: null,
  };

  constructor(
    private readonly store: GaslessCommandStore,
    private readonly processor: (
      command: GaslessCommandRecord,
    ) => Promise<GaslessCommandProcessorResult>,
    private readonly options: GaslessCommandDispatcherOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.triggerBackgroundDrain(), this.options.pollIntervalMs);
    this.timer.unref();
    this.triggerBackgroundDrain();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getQueueStats(): GaslessCommandQueueStats {
    return { ...this.queueStats };
  }

  async executeAndWait(commandId: string): Promise<unknown> {
    await this.refreshQueueStats();
    await this.processDueCommands();
    const deadline = Date.now() + this.options.waitTimeoutMs;
    while (Date.now() <= deadline) {
      const command = await this.store.getCommand(commandId);
      if (!command) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Durable gasless command disappeared', {
          commandId,
        });
      }
      if (command.status === 'completed') return command.result;
      if (command.status === 'failed' || command.status === 'dead_letter') {
        throw new GatewayError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'Durable gasless command needs review',
          {
            commandId,
            commandStatus: command.status,
            failureCode: command.lastErrorCode,
          },
        );
      }
      if (command.status === 'outcome_pending') {
        throw new GatewayError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'Durable gasless command is awaiting transaction reconciliation',
          {
            commandId,
            commandStatus: command.status,
            transactionHash: command.transactionHash,
            rebroadcastAllowed: false,
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.options.waitTimeoutMs)));
      await this.processDueCommands();
    }
    const command = await this.store.getCommand(commandId);
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Durable gasless command is still pending',
      {
        commandId,
        commandStatus: command?.status ?? 'unknown',
      },
    );
  }

  async processDueCommands(): Promise<void> {
    if (this.drain) return this.drain;
    this.drain = this.drainCommands().finally(() => {
      this.drain = null;
    });
    return this.drain;
  }

  private triggerBackgroundDrain(): void {
    void this.processDueCommands().catch((error: unknown) => {
      Logger.error('Durable gasless command scan failed', {
        error: sanitizeErrorDetail(error instanceof Error ? error.message : String(error)),
      });
    });
  }

  private async drainCommands(): Promise<void> {
    try {
      for (let index = 0; index < this.options.maxBatch; index += 1) {
        const attemptedAt = this.now();
        const leaseOwner = `${this.instanceId}:${randomUUID()}`;
        const command = await this.store.claimDueCommand(
          leaseOwner,
          attemptedAt.toISOString(),
          new Date(attemptedAt.getTime() + this.options.leaseMs).toISOString(),
        );
        if (!command) return;
        Logger.info('Durable gasless command claimed', {
          eventType: 'gateway.gasless_command.claimed',
          commandId: command.commandId,
          applicationRequestId: command.applicationRequestId,
          resourceType: command.resourceType,
          resourceId: command.resourceId,
          operation: command.operation,
          attemptCount: command.attemptCount,
        });
        await this.processClaimedCommand(command, leaseOwner);
      }
    } finally {
      await this.refreshQueueStats();
    }
  }

  private async refreshQueueStats(): Promise<void> {
    this.queueStats = await this.store.getQueueStats(this.now().toISOString());
  }

  private async processClaimedCommand(
    command: GaslessCommandRecord,
    leaseOwner: string,
  ): Promise<void> {
    const renewal = setInterval(
      () => {
        const leaseExpiresAt = new Date(this.now().getTime() + this.options.leaseMs).toISOString();
        void this.store
          .renewLease(command.commandId, leaseOwner, leaseExpiresAt)
          .then((renewed) => {
            if (!renewed) {
              Logger.error('Gasless command lease renewal lost ownership', {
                commandId: command.commandId,
                applicationRequestId: command.applicationRequestId,
              });
            }
          })
          .catch((error: unknown) => {
            Logger.error('Gasless command lease renewal failed', {
              commandId: command.commandId,
              applicationRequestId: command.applicationRequestId,
              error: sanitizeErrorDetail(error instanceof Error ? error.message : String(error)),
            });
          });
      },
      Math.max(1_000, Math.floor(this.options.leaseMs / 3)),
    );
    renewal.unref();

    try {
      const processed = await this.processor(command);
      const transactionHash =
        processed.transactionHash ?? transactionHashFromResult(processed.result);
      const committed = await this.store.markCompleted(
        command.commandId,
        leaseOwner,
        this.now().toISOString(),
        processed.result,
        transactionHash,
      );
      if (!committed) throw new Error('Gasless command completion lost lease ownership');
      Logger.info('Durable gasless command completed', {
        eventType: 'gateway.gasless_command.completed',
        commandId: command.commandId,
        applicationRequestId: command.applicationRequestId,
        resourceType: command.resourceType,
        resourceId: command.resourceId,
        operation: command.operation,
        attemptCount: command.attemptCount,
        transactionHash,
      });
    } catch (error) {
      await this.handleCommandError(command, leaseOwner, error);
    } finally {
      clearInterval(renewal);
    }
  }

  private async handleCommandError(
    command: GaslessCommandRecord,
    leaseOwner: string,
    error: unknown,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    if (isGaslessTransactionOutcomePendingError(error)) {
      await this.requireLeaseUpdate(
        this.store.markOutcomePending(
          command.commandId,
          leaseOwner,
          completedAt,
          error.transactionHash,
        ),
      );
      this.logOutcomeOwned(command, error.transactionHash, error.outcome);
      return;
    }
    if (isGaslessTransactionRevertedError(error)) {
      await this.requireLeaseUpdate(
        this.store.markOutcomePending(
          command.commandId,
          leaseOwner,
          completedAt,
          error.transactionHash,
        ),
      );
      await this.store.resolveTransactionOutcome(
        command.applicationRequestId,
        error.transactionHash,
        'reverted',
        completedAt,
      );
      this.logOutcomeOwned(command, error.transactionHash, 'reverted');
      return;
    }
    if (isGaslessPersistedOutcomeError(error)) {
      await this.requireLeaseUpdate(
        this.store.markOutcomePending(
          command.commandId,
          leaseOwner,
          completedAt,
          error.transactionHash,
        ),
      );
      await this.store.resolveTransactionOutcome(
        command.applicationRequestId,
        error.transactionHash,
        error.outcomeStatus === 'broadcast_pending' ? 'confirmation_pending' : error.outcomeStatus,
        completedAt,
      );
      this.logOutcomeOwned(command, error.transactionHash, error.outcomeStatus);
      return;
    }

    const failure = safeError(error);
    const deadLetter = !failure.retryable || command.attemptCount >= command.maxAttempts;
    const delay = Math.min(
      this.options.retryMaxMs,
      this.options.retryInitialMs * 2 ** Math.max(0, command.attemptCount - 1),
    );
    await this.requireLeaseUpdate(
      this.store.markFailed(
        command.commandId,
        leaseOwner,
        completedAt,
        failure.code,
        failure.detail,
        new Date(this.now().getTime() + delay).toISOString(),
        deadLetter,
      ),
    );
    if (deadLetter && this.options.onTerminalFailure) {
      try {
        await this.options.onTerminalFailure(command, error);
      } catch (projectionError) {
        Logger.error('Gasless command terminal failure projection failed', {
          commandId: command.commandId,
          applicationRequestId: command.applicationRequestId,
          error: sanitizeErrorDetail(
            projectionError instanceof Error ? projectionError.message : String(projectionError),
          ),
        });
      }
    }
    Logger.warn(
      deadLetter ? 'Gasless command entered dead letter' : 'Gasless command retry queued',
      {
        eventType: deadLetter
          ? 'gateway.gasless_command.dead_lettered'
          : 'gateway.gasless_command.retry_scheduled',
        commandId: command.commandId,
        applicationRequestId: command.applicationRequestId,
        operation: command.operation,
        attemptCount: command.attemptCount,
        failureCode: failure.code,
      },
    );
  }

  private async requireLeaseUpdate(update: Promise<boolean>): Promise<void> {
    if (!(await update)) throw new Error('Gasless command update lost lease ownership');
  }

  private logOutcomeOwned(
    command: GaslessCommandRecord,
    transactionHash: string,
    outcomeStatus: string,
  ): void {
    Logger.warn('Durable gasless command outcome is owned by transaction reconciliation', {
      eventType: 'gateway.gasless_command.outcome_owned',
      commandId: command.commandId,
      applicationRequestId: command.applicationRequestId,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      operation: command.operation,
      attemptCount: command.attemptCount,
      transactionHash,
      outcomeStatus,
      rebroadcastAllowed: false,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
