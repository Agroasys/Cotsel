import { SDKClient, BlockchainResult } from '../blockchain/sdk-client';
import { TriggerType } from '../types/trigger';
import { ValidationError } from '../utils/errors';

/**
 * Which escrow call each trigger type maps onto.
 *
 * Only the mapping: whether a progression is *allowed* — trade state, the
 * escrow's scoped pause, a reconciliation containment — is decided by the
 * caller before this is reached.
 */
export async function submitTriggerAction(
  sdkClient: SDKClient,
  triggerType: TriggerType,
  tradeId: string,
): Promise<BlockchainResult> {
  switch (triggerType) {
    case TriggerType.RELEASE_STAGE_1:
      return await sdkClient.releaseFundsStage1(tradeId);

    // CONFIRM_ARRIVAL is retained as an inbound trigger name for upstream callers
    // (agroasys-backend whitelists it) and maps onto the standard inspection window.
    case TriggerType.CONFIRM_ARRIVAL:
    case TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD:
      return await sdkClient.confirmInspectionAvailable(tradeId, 72 * 60 * 60);

    case TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL:
      return await sdkClient.confirmInspectionAvailable(tradeId, 48 * 60 * 60);

    case TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE:
      throw new ValidationError(
        'Buyer authorization is required; submit inspection acceptance through the gateway user-action route',
      );

    case TriggerType.FINALIZE_TRADE:
      return await sdkClient.finalizeTrade(tradeId);

    default:
      throw new Error(`Unknown trigger type: ${triggerType}`);
  }
}
