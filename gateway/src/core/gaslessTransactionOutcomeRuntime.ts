import { selectObservedSettlementRail } from '../config/retainedSettlementRails';
import { recoverUserActionSignedIdentities } from './userActionEngine/recoverSignedIdentity';
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
  runOnce(limit?: number): Promise<void>;
  start(): void;
  stop(): void;
}

export function createGaslessTransactionOutcomeRuntime(
  config: GatewayConfig,
  pool: Pool,
  settlementStore: SettlementStore,
  settlementService: SettlementService,
  recoveryScope?: 'user_action',
): GaslessTransactionOutcomeRuntime {
  const recorder = createPostgresGaslessTransactionOutcomeRecorder(pool, recoveryScope);
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
    (limit) => recoverUserActionSignedIdentities(pool, recorder, Math.min(limit, 25)),
  );

  return {
    recorder,
    runOnce: async (limit = 25) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Bounded observation recovery limit required');
      await reconciler.processUnresolved(limit);
    },
    start: () => {
      const interval = config.gaslessOutcomeReconciliationIntervalMs ?? 5000;
      if (!Number.isSafeInteger(interval) || interval < 1000)
        throw new Error('Invalid observation recovery interval');
      reconciler.start();
    },
    stop: () => reconciler.stop(),
  };
}
