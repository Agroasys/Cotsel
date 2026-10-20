import { requireFundedBinding } from '../src/core/funded-settlement-instruction';
import { TriggerType } from '../src/types/trigger';
import { fundedBindingFixture } from './helpers/fundedBinding';
describe('Exact Oracle progression purpose', () => {
  it('does not exchange buyer acceptance for deadline finalization', () => {
    expect(() =>
      requireFundedBinding(
        fundedBindingFixture(TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE),
        '1',
        TriggerType.FINALIZE_TRADE,
      ),
    ).toThrow('phase');
  });
  it('retains the separately captured deadline instruction', () => {
    expect(
      requireFundedBinding(
        fundedBindingFixture(TriggerType.FINALIZE_TRADE),
        '1',
        TriggerType.FINALIZE_TRADE,
      ).phase,
    ).toBe('final_release_after_notice_deadline');
  });
});
