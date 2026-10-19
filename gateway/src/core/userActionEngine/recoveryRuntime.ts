/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';
import type { GatewayConfig } from '../../config/gatewayConfig';
import type { SettlementStore } from '../settlementStore';
import type { SettlementService } from '../settlementService';
import { createGaslessTransactionOutcomeRuntime } from '../gaslessTransactionOutcomeRuntime';
export interface DormantUserActionRecoveryRuntime {
  runOnce(limit?: number): Promise<void>;
  start(): void;
  stop(): void;
}
/** Scoped test/owning composition reuses the production observer and its single cycle fence. */
export function createDormantUserActionRecoveryRuntime(
  config: GatewayConfig,
  pool: Pool,
  store: SettlementStore,
  service: SettlementService,
): DormantUserActionRecoveryRuntime {
  return createGaslessTransactionOutcomeRuntime(config, pool, store, service, 'user_action');
}
