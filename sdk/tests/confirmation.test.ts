import { isTreasuryConfirmationStage, isWorkflowConfirmationStage, resolveSettlementConfirmationStage } from '../src/confirmation';

describe('settlement confirmation stages', () => {
  test('keeps indexed blocks below the safe head out of workflow-confirmed state', () => {
    const state = resolveSettlementConfirmationStage(120, {
      latestBlockNumber: 125,
      safeBlockNumber: 119,
      finalizedBlockNumber: 100,
    });

    expect(state.stage).toBe('INDEXED');
    expect(isWorkflowConfirmationStage(state.stage)).toBe(false);
    expect(isTreasuryConfirmationStage(state.stage)).toBe(false);
  });

  test('marks blocks at or below the safe head as workflow-confirmed', () => {
    const state = resolveSettlementConfirmationStage(120, {
      latestBlockNumber: 130,
      safeBlockNumber: 120,
      finalizedBlockNumber: 100,
    });

    expect(state.stage).toBe('SAFE');
    expect(isWorkflowConfirmationStage(state.stage)).toBe(true);
    expect(isTreasuryConfirmationStage(state.stage)).toBe(false);
  });

  test('marks blocks at or below the finalized head as treasury-finalized', () => {
    const state = resolveSettlementConfirmationStage(120, {
      latestBlockNumber: 140,
      safeBlockNumber: 130,
      finalizedBlockNumber: 120,
    });

    expect(state.stage).toBe('FINALIZED');
    expect(isWorkflowConfirmationStage(state.stage)).toBe(true);
    expect(isTreasuryConfirmationStage(state.stage)).toBe(true);
  });
});
