/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementService } from './settlementService';
import type { SettlementStore } from './settlementStore';
import type { GaslessExecutionReceipt, GaslessSettlementExecutor } from './gaslessExecutionTypes';

export interface GaslessWorkflowContext {
  settlementService: SettlementService;
  store: SettlementStore;
  executor: GaslessSettlementExecutor;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  requestMaxTtlSeconds: number;
  now(): Date;
  assertBroadcastOpen(action: string): void;
  assertCapacityOpen(action: string): void;
  enqueueBroadcast<T>(operation: () => Promise<T>): Promise<T>;
  recordExecutionReceipt(receipt: GaslessExecutionReceipt): void;
  buildConfirmedExecutionMetadata(
    action: string,
    payloadHash: string,
    receipt: GaslessExecutionReceipt,
    extra: Record<string, unknown>,
  ): Record<string, unknown>;
}
