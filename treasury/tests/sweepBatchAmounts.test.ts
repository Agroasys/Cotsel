import { sumAllocatedEntryAmountRaw } from '../src/core/sweepBatchAmounts';

describe('sumAllocatedEntryAmountRaw', () => {
  it('uses allocated amounts as the batch authority when present', () => {
    expect(
      sumAllocatedEntryAmountRaw([
        { amount_raw: '1000', allocated_amount_raw: '750' },
        { amount_raw: '500', allocated_amount_raw: '250' },
      ]),
    ).toBe('1000');
  });

  it('falls back to source amount only when no allocation amount exists', () => {
    expect(
      sumAllocatedEntryAmountRaw([
        { amount_raw: '1000', allocated_amount_raw: null },
        { amount_raw: '500' },
      ]),
    ).toBe('1500');
  });
});
