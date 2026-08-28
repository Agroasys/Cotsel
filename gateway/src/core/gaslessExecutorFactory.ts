/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GaslessExecutorConfig } from './gaslessExecutorConfig';
import type { GaslessSettlementExecutor } from './gaslessExecutionTypes';
import { createManagedSignerGaslessSettlementExecutor } from './gaslessManagedSignerExecutor';
import { createRawPrivateKeyGaslessSettlementExecutor } from './gaslessRawPrivateKeyExecutor';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';

export function createEthersGaslessSettlementExecutor(
  config: GaslessExecutorConfig,
  dependencies?: {
    recordValidationEvidence?: ManagedSignerValidationRecorder;
  },
): GaslessSettlementExecutor {
  if (config.gaslessSignerCustodyMode && config.gaslessSignerCustodyMode !== 'raw_private_key') {
    return createManagedSignerGaslessSettlementExecutor(config, dependencies);
  }

  return createRawPrivateKeyGaslessSettlementExecutor(config);
}
