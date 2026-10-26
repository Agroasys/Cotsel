import {
  assertTransactionFinalityTransition,
  canTransitionTransactionFinality,
  classifyTransactionFinality,
  finalityFromConfirmationStage,
  isFinalizedSuccess,
  TRANSACTION_FINALITY_MODEL_VERSION,
  TRANSACTION_FINALITY_STATES,
  type TransactionFinalityObservation,
  type TransactionFinalityPosition,
} from '../src/finality';
import { SETTLEMENT_CONFIRMATION_STAGES } from '../src/confirmation';

const CHAIN_ID = 84532;
const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const OTHER_HASH = `0x${'b'.repeat(64)}`;
const REPLACEMENT_TX = `0x${'c'.repeat(64)}`;

function observation(
  overrides: Partial<TransactionFinalityObservation> = {},
): TransactionFinalityObservation {
  return {
    providerId: 'provider-a',
    chainId: CHAIN_ID,
    latestBlockNumber: 200,
    safeBlockNumber: 150,
    finalizedBlockNumber: 120,
    receipt: { blockNumber: 100, blockHash: BLOCK_HASH, status: 1 },
    canonicalBlockHash: BLOCK_HASH,
    replacement: null,
    ...overrides,
  };
}

function classify(
  observations: TransactionFinalityObservation[],
  submission: 'rejected' | 'broadcast' | 'ambiguous' = 'broadcast',
  minimumProviders?: number,
) {
  return classifyTransactionFinality({
    expectedChainId: CHAIN_ID,
    submission,
    observations,
    minimumProviders,
  });
}

describe('transaction finality model', () => {
  test('publishes one versioned vocabulary', () => {
    expect(TRANSACTION_FINALITY_MODEL_VERSION).toBe('cotsel.transaction-finality.v1');
    expect(TRANSACTION_FINALITY_STATES).toEqual([
      'submitted',
      'confirmed',
      'safe',
      'finalized',
      'reverted',
      'replaced',
      'unknown',
      'failed',
    ]);
  });

  describe('depth by block tag', () => {
    test('finalizes only at or below the finalized tag', () => {
      const assessment = classify([observation()]);
      expect(assessment).toMatchObject({
        modelVersion: TRANSACTION_FINALITY_MODEL_VERSION,
        state: 'finalized',
        depth: 'finalized',
        final: true,
        reason: 'finalized_tag_reached',
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        providerIds: ['provider-a'],
      });
      expect(isFinalizedSuccess(assessment)).toBe(true);
    });

    test('reports safe between the safe and finalized tags', () => {
      const assessment = classify([observation({ finalizedBlockNumber: 99 })]);
      expect(assessment).toMatchObject({ state: 'safe', final: false, reason: 'safe_tag_reached' });
      expect(isFinalizedSuccess(assessment)).toBe(false);
    });

    test('reports confirmed above the safe tag however many blocks deep', () => {
      const assessment = classify([
        observation({ latestBlockNumber: 10_000, safeBlockNumber: 99, finalizedBlockNumber: 50 }),
      ]);
      expect(assessment).toMatchObject({ state: 'confirmed', depth: 'included', final: false });
    });
  });

  describe('tag support', () => {
    test('never derives finality from depth when the finalized tag is unsupported', () => {
      const assessment = classify([
        observation({
          latestBlockNumber: 1_000_000,
          safeBlockNumber: 'unsupported',
          finalizedBlockNumber: 'unsupported',
        }),
      ]);
      expect(assessment).toMatchObject({
        state: 'confirmed',
        final: false,
        reason: 'finality_tag_unsupported',
      });
    });

    test('keeps safe evidence when only the finalized tag is unsupported', () => {
      expect(classify([observation({ finalizedBlockNumber: 'unsupported' })])).toMatchObject({
        state: 'safe',
        final: false,
      });
    });

    test('treats a missing tag block as no evidence', () => {
      expect(
        classify([observation({ safeBlockNumber: null, finalizedBlockNumber: null })]),
      ).toMatchObject({ state: 'confirmed', reason: 'included' });
    });
  });

  describe('wrong chain', () => {
    test('returns unknown when any provider is on another chain', () => {
      expect(
        classify([observation(), observation({ providerId: 'provider-b', chainId: 1 })]),
      ).toMatchObject({ state: 'unknown', reason: 'wrong_chain', final: false });
    });

    test('does not let a wrong-chain provider confirm a rejection', () => {
      expect(classify([observation({ chainId: 1, receipt: null })], 'rejected')).toMatchObject({
        state: 'unknown',
        reason: 'wrong_chain',
      });
    });
  });

  describe('reorganization', () => {
    test('returns unknown when the receipt block is no longer canonical', () => {
      expect(classify([observation({ canonicalBlockHash: OTHER_HASH })])).toMatchObject({
        state: 'unknown',
        reason: 'receipt_not_canonical',
        final: false,
      });
    });

    test('returns unknown when the canonical block cannot be read', () => {
      expect(classify([observation({ canonicalBlockHash: null })])).toMatchObject({
        state: 'unknown',
        reason: 'receipt_not_canonical',
      });
    });

    test('allows a confirmed transaction to fall back to unknown after a reorg', () => {
      const before = classify([observation({ safeBlockNumber: 99, finalizedBlockNumber: 50 })]);
      const after = classify([observation({ canonicalBlockHash: OTHER_HASH })]);
      expect(canTransitionTransactionFinality(before, after)).toBe(true);
    });
  });

  describe('provider disagreement', () => {
    test('returns unknown when providers report different receipt blocks', () => {
      const second = observation({
        providerId: 'provider-b',
        receipt: { blockNumber: 100, blockHash: OTHER_HASH, status: 1 },
        canonicalBlockHash: OTHER_HASH,
      });
      expect(classify([observation(), second])).toMatchObject({
        state: 'unknown',
        reason: 'provider_disagreement',
      });
    });

    test('returns unknown when providers disagree on the receipt status', () => {
      const second = observation({
        providerId: 'provider-b',
        receipt: { blockNumber: 100, blockHash: BLOCK_HASH, status: 0 },
      });
      expect(classify([observation(), second]).state).toBe('unknown');
    });

    test('returns unknown when only one provider has a receipt', () => {
      const second = observation({
        providerId: 'provider-b',
        receipt: null,
        canonicalBlockHash: null,
      });
      expect(classify([observation(), second]).reason).toBe('provider_disagreement');
    });

    test('reports the weakest depth among agreeing providers', () => {
      const lagging = observation({ providerId: 'provider-b', finalizedBlockNumber: 90 });
      expect(classify([observation(), lagging])).toMatchObject({
        state: 'safe',
        final: false,
        providerIds: ['provider-a', 'provider-b'],
      });
    });

    test('requires the configured number of distinct providers', () => {
      expect(classify([observation(), observation()], 'broadcast', 2)).toMatchObject({
        state: 'submitted',
        reason: 'insufficient_providers',
      });
      expect(classify([observation()], 'ambiguous', 2)).toMatchObject({
        state: 'unknown',
        reason: 'insufficient_providers',
      });
    });
  });

  describe('submission outcomes', () => {
    test('reports submitted while a broadcast transaction has no receipt', () => {
      expect(classify([observation({ receipt: null, canonicalBlockHash: null })])).toMatchObject({
        state: 'submitted',
        reason: 'awaiting_receipt',
        final: false,
      });
    });

    test('reports unknown while an ambiguous broadcast has no receipt', () => {
      expect(
        classify([observation({ receipt: null, canonicalBlockHash: null })], 'ambiguous'),
      ).toMatchObject({ state: 'unknown', reason: 'ambiguous_broadcast' });
    });

    test('promotes an ambiguous broadcast once its receipt is observed', () => {
      expect(classify([observation()], 'ambiguous').state).toBe('finalized');
    });

    test('reports failed only for a provable pre-broadcast rejection', () => {
      expect(
        classify([observation({ receipt: null, canonicalBlockHash: null })], 'rejected'),
      ).toMatchObject({ state: 'failed', final: true, reason: 'rejected_before_broadcast' });
      expect(classify([], 'rejected').state).toBe('failed');
      expect(classify([observation()], 'rejected')).toMatchObject({
        state: 'unknown',
        reason: 'contradicts_rejection',
      });
    });

    test('reports reverted, final only at the finalized tag', () => {
      const revert = { blockNumber: 100, blockHash: BLOCK_HASH, status: 0 as const };
      expect(classify([observation({ receipt: revert })])).toMatchObject({
        state: 'reverted',
        final: true,
      });
      expect(classify([observation({ receipt: revert, finalizedBlockNumber: 99 })])).toMatchObject({
        state: 'reverted',
        depth: 'safe',
        final: false,
      });
    });

    test('reports replaced, final only at the finalized tag', () => {
      const replacement = {
        transactionHash: REPLACEMENT_TX,
        blockNumber: 130,
        blockHash: OTHER_HASH,
      };
      const base = { receipt: null, canonicalBlockHash: OTHER_HASH, replacement };
      expect(classify([observation(base)])).toMatchObject({
        state: 'replaced',
        final: false,
        depth: 'safe',
        blockNumber: 130,
      });
      expect(classify([observation({ ...base, finalizedBlockNumber: 140 })])).toMatchObject({
        state: 'replaced',
        final: true,
      });
    });

    test.each([
      ['an unreadable', null],
      ['a conflicting', BLOCK_HASH],
    ])(
      'never reports a final replacement when its block has %s canonical hash',
      (_label, canonicalBlockHash) => {
        const replacement = {
          transactionHash: REPLACEMENT_TX,
          blockNumber: 150,
          blockHash: OTHER_HASH,
        };
        expect(
          classify([
            observation({
              receipt: null,
              canonicalBlockHash,
              replacement,
              safeBlockNumber: 160,
              finalizedBlockNumber: 150,
            }),
          ]),
        ).toMatchObject({ state: 'unknown', reason: 'replacement_not_canonical', final: false });
      },
    );
  });

  describe('invalid observations', () => {
    test.each([
      ['finalized ahead of latest', { finalizedBlockNumber: 201 }],
      ['finalized ahead of safe', { safeBlockNumber: 110, finalizedBlockNumber: 120 }],
      [
        'receipt ahead of latest',
        { latestBlockNumber: 99, safeBlockNumber: 90, finalizedBlockNumber: 80 },
      ],
      [
        'malformed block hash',
        { receipt: { blockNumber: 100, blockHash: '0x1', status: 1 as const } },
      ],
      ['negative chain id', { chainId: -1 }],
      ['empty provider id', { providerId: '' }],
    ])('returns unknown for %s', (_label, overrides) => {
      expect(
        classify([observation(overrides as Partial<TransactionFinalityObservation>)]),
      ).toMatchObject({
        state: 'unknown',
        reason: 'invalid_observation',
      });
    });
  });

  describe('transitions', () => {
    const at = (state: TransactionFinalityPosition['state'], final = false) => ({ state, final });

    test('rises through success depths', () => {
      expect(canTransitionTransactionFinality(at('submitted'), at('confirmed'))).toBe(true);
      expect(canTransitionTransactionFinality(at('confirmed'), at('safe'))).toBe(true);
      expect(canTransitionTransactionFinality(at('safe'), at('finalized', true))).toBe(true);
    });

    test('never lowers a success depth except through unknown', () => {
      expect(canTransitionTransactionFinality(at('safe'), at('confirmed'))).toBe(false);
      expect(canTransitionTransactionFinality(at('safe'), at('unknown'))).toBe(true);
      expect(canTransitionTransactionFinality(at('unknown'), at('confirmed'))).toBe(true);
    });

    test('keeps final positions terminal', () => {
      for (const terminal of [
        at('finalized', true),
        at('reverted', true),
        at('replaced', true),
        at('failed', true),
      ]) {
        expect(canTransitionTransactionFinality(terminal, at('unknown'))).toBe(false);
        expect(canTransitionTransactionFinality(terminal, terminal)).toBe(true);
      }
    });

    test('rejects non-final finalized and failed positions outright', () => {
      expect(canTransitionTransactionFinality(null, at('finalized'))).toBe(false);
      expect(canTransitionTransactionFinality(null, at('failed'))).toBe(false);
    });

    test('never turns a broadcast transaction into a pre-broadcast failure', () => {
      expect(canTransitionTransactionFinality(at('submitted'), at('failed', true))).toBe(false);
      expect(canTransitionTransactionFinality(at('unknown'), at('failed', true))).toBe(false);
      expect(() => assertTransactionFinalityTransition(at('unknown'), at('failed', true))).toThrow(
        'cannot move from unknown to failed (final)',
      );
    });

    test('lets a non-final revert or replacement become final', () => {
      expect(canTransitionTransactionFinality(at('reverted'), at('reverted', true))).toBe(true);
      expect(canTransitionTransactionFinality(at('replaced'), at('replaced', true))).toBe(true);
    });
  });

  test('maps every settlement confirmation stage, finalizing only FINALIZED', () => {
    const mapped = SETTLEMENT_CONFIRMATION_STAGES.map(finalityFromConfirmationStage);
    expect(mapped).toEqual([
      { state: 'confirmed', final: false },
      { state: 'safe', final: false },
      { state: 'finalized', final: true },
    ]);
  });
});
