/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { GatewayConfig } from '../config/gatewayConfig';
import type { SettlementService } from './settlementService';
import type { SettlementStore } from './settlementStore';
import { GaslessSettlementOutcomeObserver } from './gaslessSettlementOutcomeObserver';
import { GaslessTransactionOutcomeReconciler } from './gaslessTransactionOutcomeReconciler';
import {
  createPostgresGaslessTransactionOutcomeRecorder,
  type GaslessTransactionOutcomeStore,
} from './gaslessTransactionOutcomeStore';

export interface GaslessTransactionOutcomeRuntime {
  recorder: GaslessTransactionOutcomeStore;
  start(): void;
  stop(): void;
}

export function createGaslessTransactionOutcomeRuntime(
  config: GatewayConfig,
  pool: Pool,
  settlementStore: SettlementStore,
  settlementService: SettlementService,
): GaslessTransactionOutcomeRuntime {
  const recorder = createPostgresGaslessTransactionOutcomeRecorder(pool);
  const reconciler = config.gaslessExecutionEnabled
    ? new GaslessTransactionOutcomeReconciler(
        recorder,
        createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
          chainId: config.chainId,
          quorum: config.rpcQuorum,
        }),
        new GaslessSettlementOutcomeObserver(settlementStore, settlementService),
        config.gaslessOutcomeReconciliationIntervalMs ?? 5_000,
      )
    : null;

  return {
    recorder,
    start: () => reconciler?.start(),
    stop: () => reconciler?.stop(),
  };
}
