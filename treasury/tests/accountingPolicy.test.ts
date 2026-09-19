import {
  assertAccountingPeriodTransition,
  assertBatchAllocationAllowed,
  assertRealizationAllowed,
  assertSweepBatchTransition,
} from '../src/core/accountingPolicy';

function coveredBinding() {
  return { runKey: 'run-1', coverageToBlock: 1_000, entryBlockNumber: 900 };
}

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
        reconciliationBinding: coveredBinding(),
      }),
    ).not.toThrow();

    expect(() =>
      assertRealizationAllowed({
        batchStatus: 'HANDED_OFF',
        partnerHandoffStatus: 'ACKNOWLEDGED',
        bankPayoutState: 'CONFIRMED',
        revenueRealizationStatus: null,
        reconciliationBinding: coveredBinding(),
      }),
    ).toThrow('Revenue realization requires completed external handoff evidence');
  });

  /**
   * WP-4 H-25. A run is evidence about the range it covered. Being recent and
   * drift-free says nothing about an entry the run never reached.
   */
  describe('reconciliation watermark binding', () => {
    function realization(
      reconciliationBinding: ReturnType<typeof coveredBinding> | null,
    ): () => void {
      return () =>
        assertRealizationAllowed({
          batchStatus: 'HANDED_OFF',
          partnerHandoffStatus: 'COMPLETED',
          bankPayoutState: 'CONFIRMED',
          revenueRealizationStatus: null,
          reconciliationBinding,
        });
    }

    it('refuses realization with no reconciliation run bound to the entry', () => {
      expect(realization(null)).toThrow(
        'Revenue realization requires an accepted reconciliation run bound to the entry block',
      );
    });

    it('refuses a run whose coverage stops below the entry block', () => {
      expect(realization({ runKey: 'run-7', coverageToBlock: 900, entryBlockNumber: 901 })).toThrow(
        'run run-7 reached only 900',
      );
    });

    it('accepts a run that reached exactly the entry block', () => {
      expect(
        realization({ runKey: 'run-7', coverageToBlock: 901, entryBlockNumber: 901 }),
      ).not.toThrow();
    });
  });
});
