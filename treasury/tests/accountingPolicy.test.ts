import {
  assertAccountingPeriodTransition,
  assertBatchAllocationAllowed,
  assertRealizationAllowed,
  assertSweepBatchTransition,
} from '../src/core/accountingPolicy';

describe('accountingPolicy', () => {
  it('allows valid accounting period transitions', () => {
    expect(() => assertAccountingPeriodTransition('OPEN', 'PENDING_CLOSE')).not.toThrow();
    expect(() => assertAccountingPeriodTransition('PENDING_CLOSE', 'CLOSED')).not.toThrow();
  });

  it('rejects invalid accounting period transitions', () => {
    expect(() => assertAccountingPeriodTransition('CLOSED', 'OPEN')).toThrow(
      'Invalid accounting period transition: CLOSED -> OPEN',
    );
  });

  it('allows valid sweep batch transitions', () => {
    expect(() => assertSweepBatchTransition('DRAFT', 'PENDING_APPROVAL')).not.toThrow();
    expect(() => assertSweepBatchTransition('APPROVED', 'EXECUTED')).not.toThrow();
  });

  it('rejects invalid sweep batch transitions', () => {
    expect(() => assertSweepBatchTransition('DRAFT', 'EXECUTED')).toThrow(
      'Invalid sweep batch transition: DRAFT -> EXECUTED',
    );
  });

  it('requires open period and draft batch for allocation', () => {
    expect(() =>
      assertBatchAllocationAllowed({
        periodStatus: 'OPEN',
        batchStatus: 'DRAFT',
      }),
    ).not.toThrow();

    expect(() =>
      assertBatchAllocationAllowed({
        periodStatus: 'PENDING_CLOSE',
        batchStatus: 'DRAFT',
      }),
    ).toThrow('Sweep allocation requires an OPEN accounting period; received PENDING_CLOSE');
  });

  it('requires completed partner and confirmed bank evidence before realization', () => {
    expect(() =>
      assertRealizationAllowed({
        batchStatus: 'HANDED_OFF',
        partnerHandoffStatus: 'COMPLETED',
        bankPayoutState: 'CONFIRMED',
        revenueRealizationStatus: null,
      }),
    ).not.toThrow();

    expect(() =>
      assertRealizationAllowed({
        batchStatus: 'HANDED_OFF',
        partnerHandoffStatus: 'ACKNOWLEDGED',
        bankPayoutState: 'CONFIRMED',
        revenueRealizationStatus: null,
      }),
    ).toThrow('Revenue realization requires completed external handoff evidence');
  });
});
