import { PayoutState } from '../types';

const ALLOWED_TRANSITIONS: Record<PayoutState, PayoutState[]> = {
  PENDING_REVIEW: ['READY_FOR_PARTNER_SUBMISSION', 'CANCELLED'],
  READY_FOR_PARTNER_SUBMISSION: ['AWAITING_PARTNER_UPDATE', 'CANCELLED'],
  AWAITING_PARTNER_UPDATE: ['PARTNER_REPORTED_COMPLETED', 'CANCELLED'],
  PARTNER_REPORTED_COMPLETED: [],
  CANCELLED: [],
};

export function assertValidTransition(current: PayoutState, next: PayoutState): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid payout state transition: ${current} -> ${next}`);
  }
}
