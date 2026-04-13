import { assertValidTransition } from '../src/core/payout';

describe('Payout lifecycle transitions', () => {
  test('allows valid transitions', () => {
    expect(() =>
      assertValidTransition('PENDING_REVIEW', 'READY_FOR_PARTNER_SUBMISSION'),
    ).not.toThrow();
    expect(() =>
      assertValidTransition('READY_FOR_PARTNER_SUBMISSION', 'AWAITING_PARTNER_UPDATE'),
    ).not.toThrow();
    expect(() =>
      assertValidTransition('AWAITING_PARTNER_UPDATE', 'PARTNER_REPORTED_COMPLETED'),
    ).not.toThrow();
  });

  test('blocks invalid transitions', () => {
    expect(() => assertValidTransition('PENDING_REVIEW', 'PARTNER_REPORTED_COMPLETED')).toThrow(
      'Invalid payout state transition: PENDING_REVIEW -> PARTNER_REPORTED_COMPLETED',
    );
    expect(() =>
      assertValidTransition('PARTNER_REPORTED_COMPLETED', 'AWAITING_PARTNER_UPDATE'),
    ).toThrow(
      'Invalid payout state transition: PARTNER_REPORTED_COMPLETED -> AWAITING_PARTNER_UPDATE',
    );
  });
});
