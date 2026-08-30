/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementService } from './settlementService';
import type { SettlementStore } from './settlementStore';
import type { GaslessCommandRecord, GaslessCommandStore } from './gaslessCommandStore';
import type { GaslessExecutionReceipt, GaslessSettlementExecutor } from './gaslessExecutionTypes';

export interface GaslessWorkflowContext {
  settlementService: SettlementService;
  store: SettlementStore;
  commandStore: GaslessCommandStore;
  executor: GaslessSettlementExecutor;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  requestMaxTtlSeconds: number;
  commandMaxAttempts: number;
  commandMaxPending: number;
  now(): Date;
  assertBroadcastOpen(action: string): void;
  assertCapacityOpen(action: string): void;
  dispatchCommand<T>(command: GaslessCommandRecord): Promise<T>;
  runBroadcast<T>(applicationRequestId: string, operation: () => Promise<T>): Promise<T>;
  recordExecutionReceipt(receipt: GaslessExecutionReceipt): void;
  buildConfirmedExecutionMetadata(
    action: string,
    payloadHash: string,
    receipt: GaslessExecutionReceipt,
    extra: Record<string, unknown>,
  ): Record<string, unknown>;
}
