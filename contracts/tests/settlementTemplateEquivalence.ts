import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  AGROASYS_LAUNCH_TEMPLATE_V1 as TEMPLATE,
  computeSettlementSchedule,
  isSettlementScheduleValid,
} from '@agroasys/sdk';

const CENT = 10_000n;

/** Deterministic xorshift so failures are reproducible. */
function prng(seed: bigint) {
  let state = seed;
  return () => {
    state ^= state << 13n;
    state &= (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= (1n << 64n) - 1n;
    return state;
  };
}

type ScheduleHarness = {
  isValid: (fees: bigint, first: bigint, second: bigint) => Promise<boolean>;
};

/**
 * What AgroasysEscrow admits at trade creation: both tranches positive
 * (EscrowTranchesMustBeGreaterThan0 in _validateTradeAmounts) and
 * LaunchSettlementSchedule.isValid.
 */
async function escrowAdmits(
  contract: ScheduleHarness,
  fees: bigint,
  first: bigint,
  second: bigint,
) {
  return first > 0n && second > 0n && (await contract.isValid(fees, first, second));
}

describe('AGROASYS_LAUNCH_TEMPLATE_V1 matches what AgroasysEscrow admits', function () {
  this.timeout(120_000);

  async function harness(): Promise<ScheduleHarness> {
    const factory = await ethers.getContractFactory('LaunchSettlementScheduleHarness');
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    return contract as unknown as ScheduleHarness;
  }

  // Goods of 1 cent cannot fund a positive second tranche; covered separately below.
  const goodsCents = (() => {
    const next = prng(0x9e3779b97f4a7c15n);
    const values = [2n, 3n, 99n, 100n, 101n, 199n, 200n, 201n, 1_000n, 123_457n, 10n ** 12n];
    for (let i = 0; i < 300; i += 1) values.push((next() % 10n ** 11n) + 2n);
    return values;
  })();

  it('every schedule the template computes is admitted by the escrow', async () => {
    const contract = await harness();
    for (const cents of goodsCents) {
      const schedule = computeSettlementSchedule(TEMPLATE, cents * CENT);
      const [first, second] = schedule.supplierTranches;
      expect(
        await escrowAdmits(contract, schedule.platformFeesAmount, first, second),
        `goods ${cents} cents`,
      ).to.equal(true);
      expect(
        isSettlementScheduleValid(TEMPLATE, schedule.platformFeesAmount, [first, second]),
      ).to.equal(true);
    }
  });

  it('one cent of goods cannot fund both tranches and is rejected by both', async () => {
    const contract = await harness();
    for (const cents of [1n]) {
      expect(() => computeSettlementSchedule(TEMPLATE, cents * CENT)).to.throw(
        /positive supplier amount/,
      );
      const firstGross = ((cents * 6_000n + 5_000n) / 10_000n) * CENT;
      const second = cents * CENT - firstGross;
      expect(await escrowAdmits(contract, 4_000_000n, firstGross, second)).to.equal(false);
      expect(isSettlementScheduleValid(TEMPLATE, 4_000_000n, [firstGross, second])).to.equal(false);
    }
  });

  it('the template and the escrow agree on every perturbed schedule', async () => {
    const contract = await harness();
    const deltas = [-CENT, -1n, 1n, CENT];
    for (const cents of goodsCents.slice(0, 120)) {
      const schedule = computeSettlementSchedule(TEMPLATE, cents * CENT);
      const [first, second] = schedule.supplierTranches;
      for (const delta of deltas) {
        for (const [fees, a, b] of [
          [schedule.platformFeesAmount + delta, first, second],
          [schedule.platformFeesAmount, first + delta, second],
          [schedule.platformFeesAmount, first, second + delta],
        ]) {
          if (fees < 0n || a < 0n || b < 0n) continue;
          expect(
            isSettlementScheduleValid(TEMPLATE, fees, [a, b]),
            `goods ${cents} delta ${delta}`,
          ).to.equal(await escrowAdmits(contract, fees, a, b));
        }
      }
    }
  });

  it('the template and the escrow agree on random amounts', async () => {
    const contract = await harness();
    const next = prng(0x2545f4914f6cdd1dn);
    for (let i = 0; i < 200; i += 1) {
      const fees = (next() % 10n ** 9n) * (i % 2 === 0 ? CENT : 1n);
      const a = (next() % 10n ** 10n) * CENT;
      const b = (next() % 10n ** 10n) * CENT;
      expect(isSettlementScheduleValid(TEMPLATE, fees, [a, b])).to.equal(
        await escrowAdmits(contract, fees, a, b),
      );
    }
  });
});
