import {
  AGROASYS_LAUNCH_TEMPLATE_V1 as TEMPLATE,
  computeSettlementSchedule,
  isSettlementScheduleValid,
  settlementTemplateHash,
  settlementTemplateProblems,
  type SettlementTemplate,
} from '../src/settlement/settlementTemplate';

const USDC = 1_000_000n;
const clone = (): SettlementTemplate => JSON.parse(JSON.stringify(TEMPLATE));

describe('settlement templates', () => {
  it('template v1 is valid and its hash is stable and key-order independent', () => {
    expect(settlementTemplateProblems(TEMPLATE)).toEqual([]);
    const reordered = JSON.parse(JSON.stringify(TEMPLATE, Object.keys(TEMPLATE).reverse()));
    const fullyReordered = {
      ...reordered,
      asset: TEMPLATE.asset,
      fees: TEMPLATE.fees,
      windows: TEMPLATE.windows,
      milestones: TEMPLATE.milestones,
    };
    expect(settlementTemplateHash(fullyReordered as SettlementTemplate)).toBe(
      settlementTemplateHash(TEMPLATE),
    );
    expect(settlementTemplateHash(TEMPLATE)).toMatch(/^0x[0-9a-f]{64}$/);
    const changed = clone();
    changed.fees.buyerBps = 51;
    expect(settlementTemplateHash(changed)).not.toBe(settlementTemplateHash(TEMPLATE));
  });

  it('computes the launch schedule for 100,000 USDC of goods', () => {
    const schedule = computeSettlementSchedule(TEMPLATE, 100_000n * USDC);
    expect(schedule.buyerFee).toBe(500n * USDC);
    expect(schedule.supplierFee).toBe(500n * USDC);
    expect(schedule.supplierTranches).toEqual([59_500n * USDC, 40_000n * USDC]);
    expect(schedule.platformFeesAmount).toBe(1_004n * USDC);
    expect(
      isSettlementScheduleValid(TEMPLATE, schedule.platformFeesAmount, schedule.supplierTranches),
    ).toBe(true);
  });

  it('rejects templates that cannot settle exactly', () => {
    const cases: Array<[(t: SettlementTemplate) => void, RegExp]> = [
      [(t) => (t.milestones[1].releaseBps = 3_999), /sum to exactly 10000/],
      [(t) => (t.milestones[1].deductsSupplierFee = true), /exactly one milestone/],
      [(t) => (t.milestones[1].id = 'stage1'), /unique/],
      [(t) => (t.asset.quantumBaseUnits = '0'), /quantum/],
      [(t) => (t.fees.supplierBps = 10_000), /below 100%/],
      [(t) => (t.windows.lockTimeoutSeconds = 0), /lockTimeoutSeconds/],
    ];
    for (const [mutate, problem] of cases) {
      const template = clone();
      mutate(template);
      expect(settlementTemplateProblems(template).join('; ')).toMatch(problem);
      expect(() => computeSettlementSchedule(template, 100n * USDC)).toThrow(
        /Invalid settlement template/,
      );
    }
  });

  it('supports more than two milestones and always allocates the full goods amount', () => {
    const template = clone();
    template.milestones = [
      { id: 'dispatch', releaseBps: 3_333, deductsSupplierFee: true },
      { id: 'arrival', releaseBps: 3_333, deductsSupplierFee: false },
      { id: 'final', releaseBps: 3_334, deductsSupplierFee: false },
    ];
    const goods = 1_234_567n * 10_000n;
    const schedule = computeSettlementSchedule(template, goods);
    expect(schedule.supplierTranches.reduce((a, b) => a + b, 0n) + schedule.supplierFee).toBe(
      goods,
    );
    expect(
      isSettlementScheduleValid(template, schedule.platformFeesAmount, schedule.supplierTranches),
    ).toBe(true);
  });

  it('rejects goods amounts that are not whole quanta and malformed schedules', () => {
    expect(() => computeSettlementSchedule(TEMPLATE, 1n)).toThrow(
      /multiple of the template quantum/,
    );
    expect(() => computeSettlementSchedule(TEMPLATE, 0n)).toThrow();
    expect(isSettlementScheduleValid(TEMPLATE, 1_004n * USDC, [59_500n * USDC])).toBe(false);
    expect(
      isSettlementScheduleValid(TEMPLATE, 1_004n * USDC + 1n, [59_500n * USDC, 40_000n * USDC]),
    ).toBe(false);
  });

  it.each([0, 4_999, 5_000, 5_001, 9_000, 9_999])(
    'accepts computed schedules with supplier fee %i bps across rounding boundaries',
    (supplierBps) => {
      const template = clone();
      template.milestones = [{ id: 'final', releaseBps: 10_000, deductsSupplierFee: true }];
      template.fees.supplierBps = supplierBps;
      for (const buyerBps of [0, 50, 5_000, 10_000]) {
        template.fees.buyerBps = buyerBps;
        for (const goodsQuanta of [14n, 101n, 9_999n, 10_000n, 10_001n, 100_001n]) {
          let schedule;
          try {
            schedule = computeSettlementSchedule(template, goodsQuanta * 10_000n);
          } catch {
            continue; // Near-100% fees can consume the entire supplier tranche.
          }
          expect(
            isSettlementScheduleValid(
              template,
              schedule.platformFeesAmount,
              schedule.supplierTranches,
            ),
          ).toBe(true);
          expect(
            isSettlementScheduleValid(
              template,
              schedule.platformFeesAmount + 1n,
              schedule.supplierTranches,
            ),
          ).toBe(false);
        }
      }
    },
  );

  it('validates schedules with a support fee smaller than one quantum', () => {
    const template = clone();
    template.fees.fixedSupportFeeBaseUnits = '1';
    const schedule = computeSettlementSchedule(template, 100n * USDC);
    expect(
      isSettlementScheduleValid(template, schedule.platformFeesAmount, schedule.supplierTranches),
    ).toBe(true);
    expect(
      isSettlementScheduleValid(
        template,
        schedule.platformFeesAmount - 1n,
        schedule.supplierTranches,
      ),
    ).toBe(false);
  });
});
