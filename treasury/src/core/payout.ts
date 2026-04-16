import { PayoutState } from '../types';

const ALLOWED_TRANSITIONS: Record<PayoutState, PayoutState[]> = {
  PENDING_REVIEW: ['READY_FOR_EXTERNAL_HANDOFF', 'CANCELLED'],
  READY_FOR_EXTERNAL_HANDOFF: ['AWAITING_EXTERNAL_CONFIRMATION', 'CANCELLED'],
  AWAITING_EXTERNAL_CONFIRMATION: ['EXTERNAL_EXECUTION_CONFIRMED', 'CANCELLED'],
  EXTERNAL_EXECUTION_CONFIRMED: [],
  CANCELLED: [],
};

export function assertValidTransition(current: PayoutState, next: PayoutState): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid payout state transition: ${current} -> ${next}`);
  }
}
