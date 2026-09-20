import {
  assertCompletionEvidence,
  resolveCompletionEvidenceFailure,
  classifyProviderHandoffTransition,
  isHandedOff,
  isHandoffComplete,
  isProviderHandoffStatus,
  PROVIDER_HANDOFF_STATUSES,
  ProviderHandoffAuthorityError,
  resolveProviderHandoffAuthority,
  toSdkPartnerHandoffStatus,
  type ProviderHandoffStatus,
} from '../src/core/providerHandoffAuthority';

/**
 * WP-4 B-09 / FAIL-11.
 *
 * Two questions that treasury used to conflate: what the provider last said,
 * and whether anything has moved. Every case below is about keeping them
 * apart, or about keeping a later callback from rewriting an earlier answer.
 */
describe('provider handoff authority', () => {
  it('never treats CREATED as a handoff', () => {
    expect(resolveProviderHandoffAuthority('CREATED')).toBe('NOT_HANDED_OFF');
    expect(isHandedOff('CREATED')).toBe(false);
    expect(isHandoffComplete('CREATED')).toBe(false);
  });

  it('never treats a failed or returned instruction as a handoff', () => {
    for (const status of ['FAILED', 'RETURNED'] as ProviderHandoffStatus[]) {
      expect(resolveProviderHandoffAuthority(status)).toBe('TERMINAL_FAILED');
      expect(isHandedOff(status)).toBe(false);
      expect(isHandoffComplete(status)).toBe(false);
    }
  });

  it('treats every in-flight state as handed off but not complete', () => {
    for (const status of ['SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING'] as ProviderHandoffStatus[]) {
      expect(resolveProviderHandoffAuthority(status)).toBe('IN_FLIGHT');
      expect(isHandedOff(status)).toBe(true);
      expect(isHandoffComplete(status)).toBe(false);
    }
  });

  it('completes on exactly one state', () => {
    const complete = PROVIDER_HANDOFF_STATUSES.filter(isHandoffComplete);
    expect(complete).toEqual(['COMPLETED']);
  });

  /**
   * An unmapped state must not fall back to something benign-looking. The safe
   * default is the one that reads as progress, which is how an unrecognised
   * provider string becomes a handoff.
   */
  it('refuses a provider state it cannot map', () => {
    expect(isProviderHandoffStatus('SETTLED')).toBe(false);
    expect(() => resolveProviderHandoffAuthority('SETTLED' as ProviderHandoffStatus)).toThrow(
      ProviderHandoffAuthorityError,
    );
  });

  describe('transitions', () => {
    it('advances along the provider lifecycle', () => {
      expect(classifyProviderHandoffTransition(null, 'CREATED')).toBe('ADVANCE');
      expect(classifyProviderHandoffTransition('CREATED', 'SUBMITTED')).toBe('ADVANCE');
      expect(classifyProviderHandoffTransition('SUBMITTED', 'ACKNOWLEDGED')).toBe('ADVANCE');
      expect(classifyProviderHandoffTransition('ACKNOWLEDGED', 'COMPLETED')).toBe('ADVANCE');
    });

    it('treats the same state again as an idempotent replay', () => {
      expect(classifyProviderHandoffTransition('COMPLETED', 'COMPLETED')).toBe('REPLAY');
      expect(classifyProviderHandoffTransition('SUBMITTED', 'SUBMITTED')).toBe('REPLAY');
    });

    /**
     * Delayed and reordered callbacks are expected, not exceptional. They are
     * recorded and ignored so one authoritative outcome survives them.
     */
    it('does not let a late callback regress an established state', () => {
      expect(classifyProviderHandoffTransition('ACKNOWLEDGED', 'SUBMITTED')).toBe('STALE');
      expect(classifyProviderHandoffTransition('COMPLETED', 'PROCESSING')).toBe('STALE');
      expect(classifyProviderHandoffTransition('FAILED', 'SUBMITTED')).toBe('STALE');
    });

    /**
     * ACKNOWLEDGED and PROCESSING are the same rank on purpose: providers emit
     * one, the other, or both, and ranking them would make arrival order decide
     * the authoritative state.
     */
    it('accepts either in-flight state after the other', () => {
      expect(classifyProviderHandoffTransition('ACKNOWLEDGED', 'PROCESSING')).toBe('ADVANCE');
      expect(classifyProviderHandoffTransition('PROCESSING', 'ACKNOWLEDGED')).toBe('ADVANCE');
    });

    it('calls two different terminal claims a contradiction', () => {
      expect(classifyProviderHandoffTransition('COMPLETED', 'FAILED')).toBe('CONTRADICTION');
      expect(classifyProviderHandoffTransition('FAILED', 'COMPLETED')).toBe('CONTRADICTION');
      expect(classifyProviderHandoffTransition('COMPLETED', 'RETURNED')).toBe('CONTRADICTION');
      expect(classifyProviderHandoffTransition('RETURNED', 'FAILED')).toBe('CONTRADICTION');
    });
  });

  describe('completion evidence', () => {
    it('refuses a completion with nothing corroborating it', () => {
      expect(() => assertCompletionEvidence('COMPLETED', {})).toThrow(
        ProviderHandoffAuthorityError,
      );
      expect(() => assertCompletionEvidence('COMPLETED', { evidenceReference: '   ' })).toThrow(
        ProviderHandoffAuthorityError,
      );
    });

    it('accepts a completion carrying provider or bank evidence', () => {
      expect(() =>
        assertCompletionEvidence('COMPLETED', { evidenceReference: 'receipt-1' }),
      ).not.toThrow();
      expect(() =>
        assertCompletionEvidence('COMPLETED', { bankReference: 'wire-1' }),
      ).not.toThrow();
    });

    it('asks nothing of a state that does not assert movement', () => {
      expect(() => assertCompletionEvidence('SUBMITTED', {})).not.toThrow();
      expect(() => assertCompletionEvidence('FAILED', {})).not.toThrow();
    });

    /**
     * The non-throwing form exists so a caller can record the delivery under a
     * `REJECTED` disposition first. Refusing before recording would delete the
     * claim, and the claim is what a later dispute turns on.
     */
    it('reports the failure without throwing, for callers that log first', () => {
      expect(resolveCompletionEvidenceFailure('COMPLETED', {})).toMatch(
        /authoritative provider or bank evidence/i,
      );
      expect(resolveCompletionEvidenceFailure('COMPLETED', { bankReference: 'wire-1' })).toBeNull();
      expect(resolveCompletionEvidenceFailure('SUBMITTED', {})).toBeNull();
    });
  });

  /**
   * The accounting projection lives in a published SDK with a narrower copy of
   * this vocabulary. Narrowing preserves authority, which is all the projection
   * reads; full fidelity stays on the row.
   */
  describe('SDK narrowing', () => {
    it('keeps authority when narrowing to the SDK vocabulary', () => {
      expect(toSdkPartnerHandoffStatus('PROCESSING')).toBe('ACKNOWLEDGED');
      expect(toSdkPartnerHandoffStatus('RETURNED')).toBe('FAILED');
      expect(toSdkPartnerHandoffStatus('COMPLETED')).toBe('COMPLETED');
      expect(toSdkPartnerHandoffStatus('CREATED')).toBe('CREATED');
    });

    it('never narrows a non-complete state into a complete one', () => {
      for (const status of PROVIDER_HANDOFF_STATUSES) {
        const narrowed = toSdkPartnerHandoffStatus(status);
        expect(narrowed === 'COMPLETED').toBe(isHandoffComplete(status));
      }
    });
  });
});
