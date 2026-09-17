import {
  assertAllocationTotalMatchesExpected,
  assertAllocationWithinLedgerAmount,
  assertCanonicalFiatAmount,
  assertCanonicalRawAmount,
  formatRawAmount,
  isCanonicalRawAmount,
  MAX_RAW_AMOUNT,
  NonCanonicalAmountError,
  parseRawAmount,
  sumRawAmounts,
} from '../src/core/canonicalAmount';

describe('assertCanonicalRawAmount', () => {
  it.each(['0', '1', '4000000', MAX_RAW_AMOUNT.toString()])('accepts canonical %s', (value) => {
    expect(assertCanonicalRawAmount(value, 'amountRaw')).toBe(value);
  });

  it.each([
    ['empty string', ''],
    ['leading zero', '007'],
    ['negative', '-1'],
    ['explicit plus', '+1'],
    ['decimal', '1.5'],
    ['exponent', '1e6'],
    ['leading whitespace', ' 100'],
    ['trailing whitespace', '100 '],
    ['thousands separator', '1,000'],
    ['hex', '0x64'],
    ['non-numeric', 'NaN'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCanonicalRawAmount(value, 'amountRaw')).toThrow(NonCanonicalAmountError);
  });

  it('rejects a value above the uint256 range', () => {
    expect(() => assertCanonicalRawAmount((MAX_RAW_AMOUNT + 1n).toString(), 'amountRaw')).toThrow(
      /exceeds the uint256 range/,
    );
  });

  it('rejects input longer than the uint256 digit width before parsing', () => {
    expect(() => assertCanonicalRawAmount('9'.repeat(79), 'amountRaw')).toThrow(/79 digits/);
  });

  it.each([null, undefined, 100, {}, []])('rejects the non-string %p', (value) => {
    expect(() => assertCanonicalRawAmount(value, 'amountRaw')).toThrow(/expected a string/);
  });

  it('names the offending field so a rejection is attributable', () => {
    expect(() => assertCanonicalRawAmount('-1', 'expectedTotalRaw')).toThrow(/expectedTotalRaw/);
  });
});

describe('isCanonicalRawAmount', () => {
  it('narrows without throwing', () => {
    expect(isCanonicalRawAmount('10')).toBe(true);
    expect(isCanonicalRawAmount('010')).toBe(false);
  });
});

describe('assertCanonicalFiatAmount', () => {
  it.each(['0', '100', '125.00', '0.5', '1.12345678'])('accepts canonical %s', (value) => {
    expect(assertCanonicalFiatAmount(value, 'sourceAmount')).toBe(value);
  });

  it.each([
    ['empty string', ''],
    ['leading zero', '0100'],
    ['negative', '-125.00'],
    ['trailing separator', '125.'],
    ['too many fractional digits', '1.123456789'],
    ['exponent', '1.2e3'],
    ['whitespace', ' 125.00'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCanonicalFiatAmount(value, 'sourceAmount')).toThrow(NonCanonicalAmountError);
  });
});

describe('parseRawAmount and formatRawAmount', () => {
  it('round-trips a canonical value', () => {
    expect(formatRawAmount(parseRawAmount('4000000', 'amountRaw'), 'amountRaw')).toBe('4000000');
  });

  it('refuses to parse a non-canonical value rather than coercing it', () => {
    expect(() => parseRawAmount('007', 'amountRaw')).toThrow(NonCanonicalAmountError);
  });

  it('rejects formatting a negative bigint', () => {
    expect(() => formatRawAmount(-1n, 'amountRaw')).toThrow(/negative/);
  });
});

describe('sumRawAmounts', () => {
  it('sums exactly beyond IEEE-754 integer precision', () => {
    // 2^53 and above is where floating-point addition starts losing units.
    expect(sumRawAmounts(['9007199254740993', '1'], 'amountRaw')).toBe('9007199254740994');
  });

  it('returns zero for an empty set', () => {
    expect(sumRawAmounts([], 'amountRaw')).toBe('0');
  });

  it('rejects a non-canonical member instead of skipping it', () => {
    expect(() => sumRawAmounts(['100', ''], 'amountRaw')).toThrow(NonCanonicalAmountError);
  });
});

describe('assertAllocationWithinLedgerAmount', () => {
  it('allows a full allocation', () => {
    expect(() =>
      assertAllocationWithinLedgerAmount({
        entryAmountRaw: '1000',
        ledgerAmountRaw: '1000',
        ledgerEntryId: 7,
      }),
    ).not.toThrow();
  });

  it('allows a partial allocation', () => {
    expect(() =>
      assertAllocationWithinLedgerAmount({
        entryAmountRaw: '250',
        ledgerAmountRaw: '1000',
        ledgerEntryId: 7,
      }),
    ).not.toThrow();
  });

  it('rejects an allocation larger than the eligible ledger amount', () => {
    expect(() =>
      assertAllocationWithinLedgerAmount({
        entryAmountRaw: '1001',
        ledgerAmountRaw: '1000',
        ledgerEntryId: 7,
      }),
    ).toThrow(/exceeds the eligible ledger amount 1000 for entry 7/);
  });

  it('rejects a zero allocation', () => {
    expect(() =>
      assertAllocationWithinLedgerAmount({
        entryAmountRaw: '0',
        ledgerAmountRaw: '1000',
        ledgerEntryId: 7,
      }),
    ).toThrow(/greater than zero/);
  });
});

describe('assertAllocationTotalMatchesExpected', () => {
  it('accepts a batch whose allocations sum to the expected total', () => {
    expect(() =>
      assertAllocationTotalMatchesExpected({
        expectedTotalRaw: '1500',
        allocatedEntryAmountsRaw: ['1000', '500'],
      }),
    ).not.toThrow();
  });

  it('rejects a batch that claims more than it allocated', () => {
    expect(() =>
      assertAllocationTotalMatchesExpected({
        expectedTotalRaw: '1600',
        allocatedEntryAmountsRaw: ['1000', '500'],
      }),
    ).toThrow(/does not equal the allocated total 1500/);
  });
});
