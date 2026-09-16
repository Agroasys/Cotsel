/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GaslessExecutorConfig } from './gaslessExecutorConfig';
import type { GaslessSettlementExecutor } from './gaslessExecutionTypes';
import { GatewayError } from '../errors';
import { createManagedSignerGaslessSettlementExecutor } from './gaslessManagedSignerExecutor';
import { createRawPrivateKeyGaslessSettlementExecutor } from './gaslessRawPrivateKeyExecutor';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';
import type { GaslessTransactionOutcomeRecorder } from './gaslessTransactionOutcomeStore';
import type { GaslessNonceReservationStore } from './gaslessNonceReservationStore';

export function createEthersGaslessSettlementExecutor(
  config: GaslessExecutorConfig,
  dependencies?: {
    recordValidationEvidence?: ManagedSignerValidationRecorder;
    recordTransactionOutcome: GaslessTransactionOutcomeRecorder;
    nonceReservationStore: GaslessNonceReservationStore;
  },
): GaslessSettlementExecutor {
  if (config.gaslessSignerCustodyMode && config.gaslessSignerCustodyMode !== 'raw_private_key') {
    return createManagedSignerGaslessSettlementExecutor(config, dependencies);
  }

  if (!dependencies?.recordTransactionOutcome) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless transaction outcome persistence is not configured',
    );
  }
  return createRawPrivateKeyGaslessSettlementExecutor(
    config,
    dependencies.recordTransactionOutcome,
  );
}
