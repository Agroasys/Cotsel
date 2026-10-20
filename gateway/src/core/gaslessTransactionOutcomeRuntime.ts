import { selectObservedSettlementRail } from '../config/retainedSettlementRails';
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createGaslessFinalityVerifier } from './gaslessChainFinality';
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
  const providers = new Map<string, ReturnType<typeof createManagedRpcProvider>>();
  const reconciler = new GaslessTransactionOutcomeReconciler(
    recorder,
    (record) => {
      const rail = selectObservedSettlementRail(config, record.chainId, record.destinationAddress);
      if (!rail) throw new Error('Historical operation requires approved retained rail evidence');
      const key = `${rail.chainId}:${rail.escrowAddress.toLowerCase()}`;
      let provider = providers.get(key);
      if (!provider) {
        provider = createManagedRpcProvider(rail.rpcUrl, rail.rpcFallbackUrls, {
          chainId: rail.chainId,
          quorum: config.rpcQuorum,
        });
        providers.set(key, provider);
      }
      return provider;
    },
    new GaslessSettlementOutcomeObserver(settlementStore, settlementService),
    config.gaslessOutcomeReconciliationIntervalMs ?? 5_000,
    createGaslessFinalityVerifier(config),
  );

  return {
    recorder,
    start: () => reconciler.start(),
    stop: () => reconciler.stop(),
  };
}
