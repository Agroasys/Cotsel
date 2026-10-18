/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { GatewayConfig } from '../../config/gatewayConfig';
import type { SettlementStore } from '../settlementStore';
import type { SettlementService } from '../settlementService';
import { selectObservedSettlementRail } from '../../config/retainedSettlementRails';
import { createGaslessFinalityVerifier } from '../gaslessChainFinality';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../gaslessTransactionOutcomeStore';
import { GaslessTransactionOutcomeReconciler } from '../gaslessTransactionOutcomeReconciler';
import { GaslessSettlementOutcomeObserver } from '../gaslessSettlementOutcomeObserver';
import { Logger } from '../../logging/logger';
import { recoverUserActionSignedIdentities } from './recoverSignedIdentity';
export interface DormantUserActionRecoveryRuntime {
  runOnce(limit?: number): Promise<void>;
  start(): void;
  stop(): void;
}
/** Explicit observation scheduling. No signer/broadcast port and no server/generic-worker registration. */
export function createDormantUserActionRecoveryRuntime(
  config: GatewayConfig,
  pool: Pool,
  store: SettlementStore,
  service: SettlementService,
): DormantUserActionRecoveryRuntime {
  const recorder = createPostgresGaslessTransactionOutcomeRecorder(pool, 'user_action');
  const providers = new Map<string, ReturnType<typeof createManagedRpcProvider>>();
  const reconciler = new GaslessTransactionOutcomeReconciler(
    recorder,
    (record) => {
      const rail = selectObservedSettlementRail(config, record.chainId, record.destinationAddress);
      if (!rail) throw new Error('Retained user-action rail is unavailable');
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
    new GaslessSettlementOutcomeObserver(store, service),
    config.gaslessOutcomeReconciliationIntervalMs ?? 5000,
    createGaslessFinalityVerifier(config),
  );
  let running = false,
    timer: NodeJS.Timeout | undefined;
  const runOnce = async (limit = 25) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Bounded user-action recovery limit required');
    if (running) return;
    running = true;
    try {
      await recoverUserActionSignedIdentities(pool, recorder, limit);
      await reconciler.processUnresolved(limit);
    } finally {
      running = false;
    }
  };
  const tick = () => {
    void runOnce().catch(() =>
      Logger.error('User-action observation requires recovery', {
        reason: 'user_action_recovery_unavailable',
      }),
    );
  };
  return {
    runOnce,
    start() {
      if (timer) return;
      const interval = config.gaslessOutcomeReconciliationIntervalMs ?? 5000;
      if (!Number.isSafeInteger(interval) || interval < 1000)
        throw new Error('Invalid user-action recovery interval');
      timer = setInterval(tick, interval);
      timer.unref();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
