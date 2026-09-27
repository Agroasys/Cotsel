/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../src/errors';
import {
  ASSET_AMOUNT_SPEC,
  DISPLAY_AMOUNT_SPEC,
  assertSameMonetaryIntent,
  parseOptionalSettlementAmount,
  parseSettlementAmount,
  settlementAmountToNumber,
} from '../src/core/settlementAmount';

function rejectionReason(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).statusCode).toBe(400);
    return (error as GatewayError).details?.reason;
  }
  throw new Error('expected rejection');
}

describe('settlement amount parsing', () => {
  test.each([
    ['0', '0.00'],
    ['1000', '1000.00'],
    ['1000.5', '1000.50'],
    ['0.01', '0.01'],
    ['9999999999999.99', '9999999999999.99'],
  ])('canonicalizes display decimal string %s', (input, expected) => {
    expect(parseSettlementAmount(input, 'displayAmount', DISPLAY_AMOUNT_SPEC)).toBe(expected);
  });

  test.each([
    ['0.000001', '0.000001'],
    ['12.345678', '12.345678'],
    ['999999999.999999', '999999999.999999'],
  ])('canonicalizes asset decimal string %s', (input, expected) => {
    expect(parseSettlementAmount(input, 'assetAmount', ASSET_AMOUNT_SPEC)).toBe(expected);
  });

  test.each([
    [0, '0.00'],
    [1000, '1000.00'],
    [0.1, '0.10'],
    [623.06, '623.06'],
    [9999999999999.99, '9999999999999.99'],
  ])('accepts exactly representable legacy JSON number %p', (input, expected) => {
    expect(parseSettlementAmount(input, 'displayAmount', DISPLAY_AMOUNT_SPEC)).toBe(expected);
  });

  test('round-trips boundary and fractional limits exactly through the v1 number contract', () => {
    for (const [value, spec] of [
      ['9999999999999.99', DISPLAY_AMOUNT_SPEC],
      ['0.01', DISPLAY_AMOUNT_SPEC],
      ['1234567890123.45', DISPLAY_AMOUNT_SPEC],
      ['999999999.999999', ASSET_AMOUNT_SPEC],
      ['0.000001', ASSET_AMOUNT_SPEC],
      ['123456789.123456', ASSET_AMOUNT_SPEC],
    ] as const) {
      const canonical = parseSettlementAmount(value, 'amount', spec);
      const asNumber = settlementAmountToNumber(canonical);
      expect(parseSettlementAmount(asNumber, 'amount', spec)).toBe(canonical);
      expect(parseSettlementAmount(JSON.parse(JSON.stringify(asNumber)), 'amount', spec)).toBe(
        canonical,
      );
    }
  });

  test.each([
    ['1000.005', 'scale_exceeded'],
    ['1.000', 'scale_exceeded'],
    [1000.005, 'scale_exceeded'],
    [0.1 + 0.2, 'scale_exceeded'],
    ['10000000000000', 'magnitude_exceeded'],
    [12345678901234567.89, 'magnitude_exceeded'],
    [1e21, 'not_canonical_decimal'],
    ['-1', 'not_canonical_decimal'],
    [-1, 'not_canonical_decimal'],
    ['+1', 'not_canonical_decimal'],
    ['01', 'not_canonical_decimal'],
    ['1.', 'not_canonical_decimal'],
    ['.5', 'not_canonical_decimal'],
    ['1e3', 'not_canonical_decimal'],
    [' 1', 'not_canonical_decimal'],
    ['1,000', 'not_canonical_decimal'],
    ['', 'not_canonical_decimal'],
    [Number.NaN, 'not_finite'],
    [Number.POSITIVE_INFINITY, 'not_finite'],
    [true, 'invalid_type'],
    [null, 'invalid_type'],
    [{ value: '1' }, 'invalid_type'],
  ])('rejects display amount %p without rounding (%s)', (input, reason) => {
    expect(
      rejectionReason(() => parseSettlementAmount(input, 'displayAmount', DISPLAY_AMOUNT_SPEC)),
    ).toBe(reason);
  });

  test('rejects asset amounts beyond six decimals or nine integer digits', () => {
    expect(
      rejectionReason(() => parseSettlementAmount('12.3456789', 'assetAmount', ASSET_AMOUNT_SPEC)),
    ).toBe('scale_exceeded');
    expect(
      rejectionReason(() => parseSettlementAmount('1000000000', 'assetAmount', ASSET_AMOUNT_SPEC)),
    ).toBe('magnitude_exceeded');
  });

  test('treats absent optional amounts as null', () => {
    expect(parseOptionalSettlementAmount(undefined, 'assetAmount', ASSET_AMOUNT_SPEC)).toBeNull();
    expect(parseOptionalSettlementAmount(null, 'assetAmount', ASSET_AMOUNT_SPEC)).toBeNull();
  });
});

describe('settlement monetary intent comparison', () => {
  const intent = {
    displayCurrency: 'USD',
    displayAmount: '1000.00',
    assetSymbol: 'USDC',
    assetAmount: '1000.000000',
  };

  test('accepts an identical replay', () => {
    expect(() => assertSameMonetaryIntent(intent, { ...intent })).not.toThrow();
  });

  test('rejects a replay with a different amount as a conflict naming the fields', () => {
    try {
      assertSameMonetaryIntent(intent, { ...intent, displayAmount: '1000.01', assetAmount: null });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).statusCode).toBe(409);
      expect((error as GatewayError).details).toEqual({
        reason: 'handoff_monetary_intent_mismatch',
        fields: ['displayAmount', 'assetAmount'],
      });
    }
  });
});
