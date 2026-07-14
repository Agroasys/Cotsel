import { TradeStatus } from '@agroasys/sdk';
import { StateValidator } from '../src/core/state-validator';
import { TriggerType } from '../src/types/trigger';

describe('StateValidator inspection lifecycle', () => {
  it.each([
    TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD,
    TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL,
  ])('allows %s only while the trade is in transit', (triggerType) => {
    expect(() =>
      StateValidator.validateTradeState(
        { tradeId: '41', status: TradeStatus.IN_TRANSIT } as never,
        triggerType,
      ),
    ).not.toThrow();

    expect(() =>
      StateValidator.validateTradeState(
        { tradeId: '41', status: TradeStatus.LOCKED } as never,
        triggerType,
      ),
    ).toThrow('expected IN_TRANSIT');
  });

  it('allows the immediate finalization trigger only after inspection availability', () => {
    expect(() =>
      StateValidator.validateTradeState(
        {
          tradeId: '41',
          status: TradeStatus.ARRIVAL_CONFIRMED,
          arrivalTimestamp: new Date(),
        } as never,
        TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      ),
    ).not.toThrow();

    expect(() =>
      StateValidator.validateTradeState(
        { tradeId: '41', status: TradeStatus.IN_TRANSIT } as never,
        TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      ),
    ).toThrow('expected ARRIVAL_CONFIRMED');
  });

  it('leaves the configured deadline check to the contract', () => {
    expect(() =>
      StateValidator.validateTradeState(
        {
          tradeId: '41',
          status: TradeStatus.ARRIVAL_CONFIRMED,
          arrivalTimestamp: new Date(),
        } as never,
        TriggerType.FINALIZE_TRADE,
      ),
    ).not.toThrow();
  });
});
