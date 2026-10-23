/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { TRANSACTION_FINALITY_MODEL_VERSION } from '@agroasys/sdk';
import { triggerFinality } from '../src/core/trigger-finality';
import { TriggerStatus } from '../src/types/trigger';

const TX_HASH = `0x${'a'.repeat(64)}`;

describe('Oracle trigger finality', () => {
  test('finalizes CONFIRMED only with FINALIZED confirmation evidence', () => {
    expect(
      triggerFinality({
        status: TriggerStatus.CONFIRMED,
        tx_hash: TX_HASH,
        confirmation_stage: 'FINALIZED',
      }),
    ).toEqual({
      modelVersion: TRANSACTION_FINALITY_MODEL_VERSION,
      state: 'finalized',
      final: true,
    });
  });

  test.each([
    ['SAFE', { state: 'safe', final: false }],
    ['INDEXED', { state: 'confirmed', final: false }],
  ] as const)('never promotes a CONFIRMED row at %s to final', (stage, expected) => {
    expect(
      triggerFinality({
        status: TriggerStatus.CONFIRMED,
        tx_hash: TX_HASH,
        confirmation_stage: stage,
      }),
    ).toMatchObject(expected);
  });

  test.each([
    ['no confirmation stage', { tx_hash: TX_HASH, confirmation_stage: null }],
    ['no transaction hash', { tx_hash: null, confirmation_stage: 'FINALIZED' as const }],
  ])('reports a CONFIRMED row with %s as unknown', (_label, fields) => {
    expect(triggerFinality({ status: TriggerStatus.CONFIRMED, ...fields })).toMatchObject({
      state: 'unknown',
      final: false,
    });
  });

  test('reports SUBMITTED with a hash as submitted and without one as unknown', () => {
    expect(
      triggerFinality({
        status: TriggerStatus.SUBMITTED,
        tx_hash: TX_HASH,
        confirmation_stage: null,
      }),
    ).toMatchObject({ state: 'submitted', final: false });
    expect(
      triggerFinality({ status: TriggerStatus.SUBMITTED, tx_hash: null, confirmation_stage: null }),
    ).toMatchObject({ state: 'unknown' });
  });

  test('reports a claimed dispatch with no outcome as unknown', () => {
    expect(
      triggerFinality({
        status: TriggerStatus.EXECUTING,
        tx_hash: null,
        confirmation_stage: null,
        dispatch_started_at: new Date(),
      }),
    ).toMatchObject({ state: 'unknown', final: false });
  });

  test('covers every trigger status without ever reporting a final state early', () => {
    for (const status of Object.values(TriggerStatus)) {
      const withoutTransaction = triggerFinality({
        status,
        tx_hash: null,
        confirmation_stage: null,
      });
      if (status === TriggerStatus.CONFIRMED || status === TriggerStatus.SUBMITTED) {
        expect(withoutTransaction).toMatchObject({ state: 'unknown', final: false });
      } else {
        expect(withoutTransaction).toBeNull();
      }

      const withTransaction = triggerFinality({
        status,
        tx_hash: TX_HASH,
        confirmation_stage: null,
      });
      expect(withTransaction?.final).toBe(false);
    }
  });
});
