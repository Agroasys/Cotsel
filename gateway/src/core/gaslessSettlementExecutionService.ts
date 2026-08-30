/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type { GatewayPrincipal } from '../middleware/auth';
import { resolveGatewayActorKey } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import { Logger } from '../logging/logger';
import { SettlementService } from './settlementService';
import { SettlementStore } from './settlementStore';
import { GaslessCommandDispatcher } from './gaslessCommandDispatcher';
import {
  createGaslessCommandIntentKey,
  type GaslessCommandDeadLetter,
  type GaslessCommandRecord,
  type GaslessCommandStore,
} from './gaslessCommandStore';
import { calculateGaslessExecutorCapacityPolicy } from './gaslessExecutorCapacityPolicy';
import { buildConfirmedMetadata } from './gaslessExecutionEvidence';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessCreateTradeExecutionResult,
  GaslessExecutionReceipt,
  GaslessOperatorActionExecutionInput,
  GaslessRelayerReadinessSnapshot,
  GaslessSettlementExecutor,
  GaslessUserActionExecutionInput,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import { createManagedSignerGaslessSettlementExecutor } from './gaslessManagedSignerExecutor';
import { executeCreateTradeWorkflow } from './gaslessCreateTradeWorkflow';
import { executeOperatorActionWorkflow } from './gaslessOperatorActionWorkflow';
import { executeUserActionWorkflow } from './gaslessUserActionWorkflow';
import { executeWalletUsdcTransferWorkflow } from './gaslessWalletUsdcTransferWorkflow';
import { createInProcessGaslessRelayerBroadcastLock } from './gaslessRelayerRuntime';
import { buildGaslessRelayerReadiness } from './gaslessRelayerReadiness';
import type { GaslessRelayerBroadcastLock } from './gaslessRelayerRuntime';
import { createGaslessPayloadHash } from './gaslessRequestNormalization';
import { buildCreateTradeArguments, buildUserActionArguments } from './gaslessTransactionEncoding';
import { GaslessPersistedOutcomeError } from './gaslessTransactionLifecycle';
import type { GaslessTransactionOutcomeStore } from './gaslessTransactionOutcomeStore';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';

export type {
  GaslessBuyerAuthorization,
  GaslessCreateTradeExecutionInput,
  GaslessCreateTradeExecutionResult,
  GaslessExecutionReceipt,
  GaslessExecutionSubmission,
  GaslessOperatorAction,
  GaslessOperatorActionExecutionInput,
  GaslessRelayerReadinessSnapshot,
  GaslessSettlementExecutor,
  GaslessUserAction,
  GaslessUserActionAuthorization,
  GaslessUserActionExecutionInput,
  GaslessUsdcAuthorization,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
export { createEthersGaslessSettlementExecutor } from './gaslessExecutorFactory';
export type { GaslessRelayerBroadcastLock } from './gaslessRelayerRuntime';
export class GaslessSettlementExecutionService {
  private readonly commandDispatcher: GaslessCommandDispatcher;
  private readonly broadcastLock: GaslessRelayerBroadcastLock;
  private pendingBroadcastQueuedAtMs: number[] = [];
  private pendingBroadcasts = 0;
  private activeBroadcasts = 0;
  private lastQueueWaitMs: number | null = null;
  private lastSubmissionAt: string | null = null;
  private lastExecutorBalanceWei: bigint | null = null;
  private repeatedFailureCount = 0;

  constructor(
    private readonly settlementService: SettlementService,
    private readonly store: SettlementStore & GaslessCommandStore,
    private readonly executor: GaslessSettlementExecutor,
    private readonly transactionOutcomeStore: GaslessTransactionOutcomeStore,
    private readonly options: {
      chainId: number;
      escrowAddress: string;
      usdcAddress: string;
      requestMaxTtlSeconds: number;
      broadcastPaused?: boolean;
      signerCustodyMode?: 'raw_private_key' | 'kms' | 'mpc';
      rpcFallbackCount?: number;
      gasLimitCap?: bigint;
      maxFeePerGasWei?: bigint;
      maxNativeCostWei?: bigint;
      minExecutorBalanceWei?: bigint;
      lowBalanceAlertWei?: bigint;
      capacityTargetTxPerDay?: number;
      capacityBurstMultiplierBasisPoints?: number;
      capacitySafetyMarginBasisPoints?: number;
      capacityRequiredExecutorBalanceWei?: bigint;
      capacityFailClosed?: boolean;
      stuckQueueThresholdMs?: number;
      receiptTimeoutMs?: number;
      repeatedFailureAlertThreshold?: number;
      commandLeaseMs?: number;
      commandPollIntervalMs?: number;
      commandRetryInitialMs?: number;
      commandRetryMaxMs?: number;
      commandWaitTimeoutMs?: number;
      commandMaxAttempts?: number;
      commandMaxPending?: number;
      commandMaxBatch?: number;
      broadcastLock?: GaslessRelayerBroadcastLock;
      now?: () => Date;
    },
  ) {
    this.broadcastLock = options.broadcastLock ?? createInProcessGaslessRelayerBroadcastLock();
    this.commandDispatcher = new GaslessCommandDispatcher(
      store,
      (command) => this.processCommand(command),
      {
        leaseMs: options.commandLeaseMs ?? 30_000,
        pollIntervalMs: options.commandPollIntervalMs ?? 1_000,
        retryInitialMs: options.commandRetryInitialMs ?? 1_000,
        retryMaxMs: options.commandRetryMaxMs ?? 30_000,
        waitTimeoutMs: options.commandWaitTimeoutMs ?? 15_000,
        maxBatch: options.commandMaxBatch ?? 25,
        now: options.now,
        onTerminalFailure: (command, error) => this.recordTerminalFailure(command, error),
      },
    );
  }

  start(): void {
    this.commandDispatcher.start();
  }

  stop(): void {
    this.commandDispatcher.stop();
  }

  async executeWalletUsdcTransfer(input: GaslessWalletUsdcTransferExecutionInput): Promise<{
    platformTransferId: string;
    txHash: string;
    receipt: GaslessExecutionReceipt;
    requestId: string;
  }> {
    return executeWalletUsdcTransferWorkflow(this.createWorkflowContext(), input);
  }

  getRelayerReadiness(): GaslessRelayerReadinessSnapshot {
    return buildGaslessRelayerReadiness({
      options: this.options,
      pendingBroadcastQueuedAtMs: this.pendingBroadcastQueuedAtMs,
      pendingBroadcasts: this.pendingBroadcasts,
      activeBroadcasts: this.activeBroadcasts,
      lastQueueWaitMs: this.lastQueueWaitMs,
      lastSubmissionAt: this.lastSubmissionAt,
      lastExecutorBalanceWei: this.lastExecutorBalanceWei,
      repeatedFailureCount: this.repeatedFailureCount,
      durableQueue: this.commandDispatcher.getQueueStats(),
    });
  }

  listDeadLetterCommands(limit = 100): Promise<GaslessCommandDeadLetter[]> {
    return this.store.listDeadLetters(limit);
  }

  async redriveDeadLetterCommand(
    commandId: string,
    context: {
      route: string;
      method: string;
      idempotencyKey: string;
      principal: GatewayPrincipal;
      requestContext: Pick<RequestContext, 'requestId' | 'correlationId'>;
    },
  ): Promise<GaslessCommandRecord> {
    const command = await this.store.getCommand(commandId);
    if (!command) {
      throw new GatewayError(404, 'NOT_FOUND', 'Durable gasless command not found', { commandId });
    }
    if (command.status !== 'dead_letter') {
      throw new GatewayError(409, 'CONFLICT', 'Durable gasless command is not in dead letter', {
        commandId,
        commandStatus: command.status,
      });
    }
    const outcome = await this.transactionOutcomeStore.getByApplicationRequestId(
      command.applicationRequestId,
    );
    if (command.transactionHash || outcome) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Transaction reconciliation owns this durable gasless command',
        {
          commandId,
          transactionHash: command.transactionHash ?? outcome?.transactionHash,
          rebroadcastAllowed: false,
        },
      );
    }
    const redriven = await this.store.redriveDeadLetter(
      commandId,
      (this.options.now?.() ?? new Date()).toISOString(),
      {
        eventType: 'gateway.gasless_command.redriven',
        route: context.route,
        method: context.method,
        requestId: context.requestContext.requestId,
        correlationId: context.requestContext.correlationId,
        actionId: command.commandId,
        idempotencyKey: context.idempotencyKey,
        actorId: resolveGatewayActorKey(context.principal.session),
        actorUserId: context.principal.session.userId,
        actorWalletAddress: context.principal.session.walletAddress,
        actorRole: context.principal.session.role,
        status: 'queued',
        metadata: {
          commandId: command.commandId,
          applicationRequestId: command.applicationRequestId,
          resourceType: command.resourceType,
          resourceId: command.resourceId,
          operation: command.operation,
          previousAttemptCount: command.attemptCount,
          authorizedMaxAttempts: command.attemptCount + 1,
        },
      },
    );
    if (!redriven) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Durable gasless command changed before redrive; review its current state',
        { commandId },
      );
    }
    Logger.warn('Operator redrove durable gasless command', {
      commandId,
      applicationRequestId: redriven.applicationRequestId,
      operation: redriven.operation,
      attemptCount: redriven.attemptCount,
      nextAttemptAt: redriven.nextAttemptAt,
    });
    return redriven;
  }

  private recordExecutionReceipt(receipt: GaslessExecutionReceipt): void {
    this.lastExecutorBalanceWei = BigInt(receipt.executorBalanceWei);
  }

  private createWorkflowContext(): GaslessWorkflowContext {
    return {
      settlementService: this.settlementService,
      store: this.store,
      executor: this.executor,
      chainId: this.options.chainId,
      escrowAddress: this.options.escrowAddress,
      usdcAddress: this.options.usdcAddress,
      requestMaxTtlSeconds: this.options.requestMaxTtlSeconds,
      commandMaxAttempts: this.options.commandMaxAttempts ?? 5,
      commandMaxPending: this.options.commandMaxPending ?? 100,
      commandStore: this.store,
      now: () => this.options.now?.() ?? new Date(),
      assertBroadcastOpen: (action) => this.assertBroadcastOpen(action),
      assertCapacityOpen: (action) => this.assertCapacityOpen(action),
      dispatchCommand: <T>(command: GaslessCommandRecord) =>
        this.commandDispatcher.executeAndWait(command.commandId) as Promise<T>,
      runBroadcast: (applicationRequestId, operation) =>
        this.runBroadcast(applicationRequestId, operation),
      recordExecutionReceipt: (receipt) => this.recordExecutionReceipt(receipt),
      buildConfirmedExecutionMetadata: (action, payloadHash, receipt, extra) =>
        this.buildConfirmedExecutionMetadata(action, payloadHash, receipt, extra),
    };
  }

  private buildConfirmedExecutionMetadata(
    action: string,
    payloadHash: string,
    receipt: GaslessExecutionReceipt,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return buildConfirmedMetadata(action, payloadHash, receipt, {
      minExecutorBalanceWei: (this.options.minExecutorBalanceWei ?? 0n).toString(),
      lowBalanceAlertWei: (this.options.lowBalanceAlertWei ?? 0n).toString(),
      ...extra,
    });
  }

  private assertBroadcastOpen(action: string): void {
    if (!this.options.broadcastPaused) {
      return;
    }

    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless relayer broadcast is paused', {
      action,
      reason: 'operator_kill_switch',
    });
  }

  private assertCapacityOpen(action: string): void {
    if (!this.options.capacityFailClosed || this.lastExecutorBalanceWei === null) {
      return;
    }

    const gasLimitCap = this.options.gasLimitCap ?? 1_500_000n;
    const maxFeePerGasWei = this.options.maxFeePerGasWei ?? 50_000_000_000n;
    const capacityPolicy = calculateGaslessExecutorCapacityPolicy({
      targetTransactionsPerDay: this.options.capacityTargetTxPerDay ?? 500,
      burstMultiplierBasisPoints: this.options.capacityBurstMultiplierBasisPoints ?? 40_000,
      safetyMarginBasisPoints: this.options.capacitySafetyMarginBasisPoints ?? 12_500,
      maxCostPerTxWei: gasLimitCap * maxFeePerGasWei,
      configuredMinExecutorBalanceWei: this.options.minExecutorBalanceWei ?? 0n,
      configuredLowBalanceAlertWei: this.options.lowBalanceAlertWei ?? 0n,
      failClosed: true,
    });
    const requiredExecutorBalanceWei =
      this.options.capacityRequiredExecutorBalanceWei ??
      BigInt(capacityPolicy.requiredBurstHourBalanceWei);

    if (this.lastExecutorBalanceWei >= requiredExecutorBalanceWei) {
      return;
    }

    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless executor balance is below fail-closed capacity policy',
      {
        action,
        executorBalanceWei: this.lastExecutorBalanceWei.toString(),
        requiredExecutorBalanceWei: requiredExecutorBalanceWei.toString(),
      },
    );
  }

  private async runBroadcast<T>(
    applicationRequestId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queuedAtMs = Date.now();
    this.pendingBroadcasts += 1;
    this.pendingBroadcastQueuedAtMs.push(queuedAtMs);

    const run = this.broadcastLock.runExclusive(async () => {
      this.pendingBroadcasts -= 1;
      const queuedIndex = this.pendingBroadcastQueuedAtMs.indexOf(queuedAtMs);
      if (queuedIndex >= 0) {
        this.pendingBroadcastQueuedAtMs.splice(queuedIndex, 1);
      } else {
        this.pendingBroadcastQueuedAtMs.shift();
      }
      this.activeBroadcasts += 1;
      this.lastQueueWaitMs = Date.now() - queuedAtMs;
      try {
        const persisted =
          await this.transactionOutcomeStore.getByApplicationRequestId(applicationRequestId);
        if (persisted) {
          if (persisted.outcomeStatus === 'replaced' || persisted.outcomeStatus === 'failed') {
            throw new GatewayError(
              409,
              'CONFLICT',
              'Gasless transaction request already has a terminal durable outcome',
              {
                applicationRequestId,
                transactionHash: persisted.transactionHash,
                outcome: persisted.outcomeStatus,
                rebroadcastAllowed: false,
              },
            );
          }
          throw new GaslessPersistedOutcomeError(
            persisted.transactionHash,
            persisted.outcomeStatus,
          );
        }
        const result = await operation();
        this.lastSubmissionAt = (this.options.now?.() ?? new Date()).toISOString();
        this.repeatedFailureCount = 0;
        return result;
      } catch (error) {
        this.repeatedFailureCount += 1;
        throw error;
      } finally {
        this.activeBroadcasts -= 1;
      }
    });
    return run;
  }

  private async processCommand(command: GaslessCommandRecord): Promise<{
    result: unknown;
    transactionHash?: string | null;
  }> {
    const {
      requestId: payloadRequestId,
      sourceApiKeyId: _sourceApiKeyId,
      ...intentPayload
    } = command.payload;
    if (
      payloadRequestId !== command.applicationRequestId ||
      createGaslessCommandIntentKey(intentPayload) !== command.intentKey
    ) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Durable gasless command payload no longer matches its accepted financial intent',
        { commandId: command.commandId },
      );
    }
    let result: unknown;
    if (command.operation === 'create_trade') {
      result = await executeCreateTradeWorkflow(
        this.createWorkflowContext(),
        command.payload as unknown as GaslessCreateTradeExecutionInput,
        command,
      );
    } else if (command.operation === 'wallet_usdc_transfer') {
      result = await executeWalletUsdcTransferWorkflow(
        this.createWorkflowContext(),
        command.payload as unknown as GaslessWalletUsdcTransferExecutionInput,
        command,
      );
    } else if ('userAuthorization' in command.payload) {
      result = await executeUserActionWorkflow(
        this.createWorkflowContext(),
        command.payload as unknown as GaslessUserActionExecutionInput,
        command,
      );
    } else {
      result = await executeOperatorActionWorkflow(
        this.createWorkflowContext(),
        command.payload as unknown as GaslessOperatorActionExecutionInput,
        command,
      );
    }
    const transactionHash =
      result && typeof result === 'object' && 'txHash' in result
        ? String((result as { txHash: unknown }).txHash)
        : null;
    return { result, transactionHash };
  }

  private async recordTerminalFailure(
    command: GaslessCommandRecord,
    error: unknown,
  ): Promise<void> {
    if (command.resourceType !== 'settlement_handoff') return;
    const handoff = await this.store.getHandoff(command.resourceId);
    if (!handoff) return;
    await this.settlementService.recordExecutionEvent({
      handoffId: command.resourceId,
      eventType: 'failed',
      executionStatus: 'failed',
      reconciliationStatus: handoff.reconciliationStatus,
      providerStatus: 'gasless_command_dead_letter',
      detail: 'Durable gasless execution exhausted its bounded retry policy.',
      metadata: {
        action: command.operation,
        commandId: command.commandId,
        failureCode: error instanceof GatewayError ? error.code : 'UNEXPECTED_ERROR',
      },
      observedAt: (this.options.now?.() ?? new Date()).toISOString(),
      requestId: command.applicationRequestId,
    });
  }

  async executeCreateTrade(
    input: GaslessCreateTradeExecutionInput,
  ): Promise<GaslessCreateTradeExecutionResult> {
    return executeCreateTradeWorkflow(this.createWorkflowContext(), input);
  }
  async executeUserAction(
    input: GaslessUserActionExecutionInput,
  ): Promise<GaslessCreateTradeExecutionResult> {
    return executeUserActionWorkflow(this.createWorkflowContext(), input);
  }
  async executeOperatorAction(
    input: GaslessOperatorActionExecutionInput,
  ): Promise<GaslessCreateTradeExecutionResult> {
    return executeOperatorActionWorkflow(this.createWorkflowContext(), input);
  }
}

export const testExports = {
  createPayloadHash: createGaslessPayloadHash,
  buildCreateTradeArguments,
  buildUserActionArguments,
  createManagedSignerGaslessSettlementExecutor,
};
