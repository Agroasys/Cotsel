import { parseSettlementFundedBinding, type SettlementFundedBinding } from '@agroasys/sdk';
import { TriggerType } from '../types/trigger';
import { ValidationError } from '../utils/errors';

export function requireFundedBinding(
  value: unknown,
  tradeId: string,
  triggerType: TriggerType,
): SettlementFundedBinding {
  let binding: SettlementFundedBinding;
  try {
    binding = parseSettlementFundedBinding(value);
  } catch {
    throw new ValidationError(
      'An immutable original funded binding is required for financial execution',
    );
  }
  const phases: Partial<Record<TriggerType, readonly string[]>> = {
    [TriggerType.RELEASE_STAGE_1]: ['initial_release_after_custody_and_documents'],
    [TriggerType.CONFIRM_ARRIVAL]: ['inspection_available_standard'],
    [TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD]: ['inspection_available_standard'],
    [TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL]: [
      'inspection_available_packaged_local',
    ],
    [TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE]: [
      'final_release_after_inspection_acceptance',
    ],
    [TriggerType.FINALIZE_TRADE]: ['final_release_after_notice_deadline'],
  };
  if (binding.tradeId !== tradeId || !phases[triggerType]?.includes(binding.phase))
    throw new ValidationError(
      'The progression phase or trade differs from the original funded instruction',
    );
  return binding;
}
