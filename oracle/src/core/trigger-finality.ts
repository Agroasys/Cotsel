/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  finalityFromConfirmationStage,
  TRANSACTION_FINALITY_MODEL_VERSION,
  type TransactionFinalityPosition,
} from '@agroasys/sdk';
import { type Trigger, TriggerStatus } from '../types/trigger';

export interface OracleTriggerFinality extends TransactionFinalityPosition {
  modelVersion: typeof TRANSACTION_FINALITY_MODEL_VERSION;
}

/**
 * WP-2 H-02. Maps a stored trigger onto the shared finality model. `null`
 * means the trigger owns no transaction yet. CONFIRMED is only final when the
 * row also carries FINALIZED confirmation evidence; anything else is unknown.
 */
export function triggerFinality(
  trigger: Pick<Trigger, 'status' | 'tx_hash' | 'confirmation_stage'> &
    Partial<Pick<Trigger, 'dispatch_started_at'>>,
): OracleTriggerFinality | null {
  const position = ((): TransactionFinalityPosition | null => {
    switch (trigger.status) {
      case TriggerStatus.CONFIRMED:
        return trigger.tx_hash && trigger.confirmation_stage
          ? finalityFromConfirmationStage(trigger.confirmation_stage)
          : { state: 'unknown', final: false };
      case TriggerStatus.SUBMITTED:
        return trigger.tx_hash
          ? { state: 'submitted', final: false }
          : { state: 'unknown', final: false };
      default:
        // A claimed dispatch with no resolved outcome may have reached the network.
        return trigger.tx_hash || trigger.dispatch_started_at
          ? { state: 'unknown', final: false }
          : null;
    }
  })();
  return position ? { modelVersion: TRANSACTION_FINALITY_MODEL_VERSION, ...position } : null;
}
