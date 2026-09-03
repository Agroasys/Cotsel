/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { SettlementService } from './settlementService';
import { SettlementStore } from './settlementStore';
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
  private broadcastQueue: Promise<void> = Promise.resolve();
  private pendingBroadcastQueuedAtMs: number[] = [];
  private pendingBroadcasts = 0;
  private activeBroadcasts = 0;
  private lastQueueWaitMs: number | null = null;
  private lastSubmissionAt: string | null = null;
  private lastExecutorBalanceWei: bigint | null = null;
  private repeatedFailureCount = 0;

  constructor(
    private readonly settlementService: SettlementService,
    private readonly store: SettlementStore,
    private readonly executor: GaslessSettlementExecutor,
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
      broadcastLock?: GaslessRelayerBroadcastLock;
      now?: () => Date;
    },
  ) {}

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
    });
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
      now: () => this.options.now?.() ?? new Date(),
      assertBroadcastOpen: (action) => this.assertBroadcastOpen(action),
      assertCapacityOpen: (action) => this.assertCapacityOpen(action),
      enqueueBroadcast: (operation) => this.enqueueBroadcast(operation),
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

  private async enqueueBroadcast<T>(operation: () => Promise<T>): Promise<T> {
    const queuedAtMs = Date.now();
    this.pendingBroadcasts += 1;
    this.pendingBroadcastQueuedAtMs.push(queuedAtMs);

    const run = this.broadcastQueue.then(async () => {
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
        const result = await (
          this.options.broadcastLock ?? createInProcessGaslessRelayerBroadcastLock()
        ).runExclusive(operation);
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

    this.broadcastQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
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
