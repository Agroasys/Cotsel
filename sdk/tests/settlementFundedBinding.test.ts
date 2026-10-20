import {
  parseSettlementFundedBinding,
  assertFundedTradeMatchesBinding,
} from '../src/settlementFundedBinding';
import { fundedBindingFixture } from './fixtures/fundedBinding';
import { TradeStatus, type Trade } from '../src/types/trade';
const binding = fundedBindingFixture();
const trade: Trade = {
  tradeId: '1',
  buyer: binding.buyerAddress,
  supplier: binding.supplierAddress,
  status: TradeStatus.LOCKED,
  totalAmountLocked: 1000n,
  logisticsAmount: 100n,
  platformFeesAmount: 50n,
  supplierFirstTranche: 350n,
  supplierSecondTranche: 500n,
  ricardianHash: binding.ricardianHash,
  createdAt: new Date(),
};
describe('immutable funded progression scope', () => {
  it('accepts the deployed escrow first trade identifier zero while retaining full scope matching', () => {
    const first = { ...binding, tradeId: '0' };
    expect(parseSettlementFundedBinding(first).tradeId).toBe('0');
    expect(() => assertFundedTradeMatchesBinding({ ...trade, tradeId: '0' }, first)).not.toThrow();
    expect(() => assertFundedTradeMatchesBinding(trade, first)).toThrow();
    for (const tradeId of ['-1', '00', '0.0', '1e0']) {
      expect(() => parseSettlementFundedBinding({ ...binding, tradeId })).toThrow();
    }
  });
  it('normalizes representation and fixes the serialized field order', () => {
    const reversed = Object.fromEntries(Object.entries(binding).reverse());
    expect(JSON.stringify(parseSettlementFundedBinding(reversed))).toBe(JSON.stringify(binding));
    expect(() => assertFundedTradeMatchesBinding(trade, binding)).not.toThrow();
  });
  it.each([
    { buyerAddress: `0x${'6'.repeat(40)}` },
    { supplierAddress: `0x${'7'.repeat(40)}` },
    { ricardianHash: `0x${'8'.repeat(64)}` },
    { tradeId: '2' },
    { logisticsAmount: '101', totalAmount: '1001', treasuryAccrualAmount: '151' },
    { supplierSecondTranche: '501', totalAmount: '1001' },
  ])('rejects altered original chain facts %#', (overrides) => {
    expect(() => assertFundedTradeMatchesBinding(trade, { ...binding, ...overrides })).toThrow();
  });
  it.each([
    { chainId: '1e3' },
    { chainId: '9007199254740992' },
    { buyerAddress: 'invalid' },
    { tokenAddress: `0x${'0'.repeat(40)}` },
    { phase: 'arbitrary' },
    { totalAmount: '999' },
    { supplierPayoutAmount: '351' },
    { treasuryAccrualAmount: '149' },
    { buyerRefundAmount: '1' },
    { unexpected: true },
    { fundingBlockHash: '0x123' },
    { sourceOperationId: '' },
  ])('rejects incomplete, malformed and mismatched instruction scope %#', (overrides) => {
    expect(() => parseSettlementFundedBinding({ ...binding, ...overrides })).toThrow();
  });
  it('requires every field and rejects non-string integers', () => {
    for (const key of Object.keys(binding)) {
      const partial = { ...binding } as Record<string, unknown>;
      delete partial[key];
      expect(() => parseSettlementFundedBinding(partial)).toThrow();
    }
    expect(() => parseSettlementFundedBinding({ ...binding, tradeId: 1 })).toThrow();
  });
});
