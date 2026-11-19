// SPDX-License-Identifier: Apache-2.0
/**
 * Versioned settlement templates (#940).
 *
 * A template describes a settlement's terms: milestone release shares, fees,
 * rounding, the settlement asset and timing windows. It is identified by a
 * SHA-256 over its canonical JSON, so a settlement can record exactly which
 * terms it was created against.
 *
 * Today the contract enforces fixed terms (contracts/src/LaunchSettlementSchedule.sol).
 * AGROASYS_LAUNCH_TEMPLATE_V1 describes those terms, and the contracts test
 * suite proves this module computes and validates schedules identically to the
 * contract. On-chain enforcement of arbitrary templates is a later contract
 * version (#955).
 */
import { sha256, toUtf8Bytes } from 'ethers';

export const SETTLEMENT_TEMPLATE_SCHEMA_VERSION = 'cotsel.settlement-template.v1';
const BPS = 10_000n;
const HALF_BPS = 5_000n;

export interface SettlementTemplateMilestone {
  /** Stable milestone identifier, unique within the template. */
  id: string;
  /** Share of the goods amount released at this milestone, in basis points. */
  releaseBps: number;
  /** The supplier fee is deducted from exactly one milestone. */
  deductsSupplierFee: boolean;
}

export interface SettlementTemplate {
  schemaVersion: typeof SETTLEMENT_TEMPLATE_SCHEMA_VERSION;
  templateId: string;
  version: number;
  asset: {
    symbol: string;
    decimals: number;
    /** Smallest quotable amount in base units; every amount is a multiple of it. */
    quantumBaseUnits: string;
  };
  milestones: SettlementTemplateMilestone[];
  fees: {
    buyerBps: number;
    supplierBps: number;
    fixedSupportFeeBaseUnits: string;
    /** Each percentage amount is rounded half up to a whole quantum. */
    rounding: 'half-up-per-quantum';
  };
  windows: {
    standardInspectionSeconds: number;
    packagedLocalInspectionSeconds: number;
    lockTimeoutSeconds: number;
    inTransitTimeoutSeconds: number;
    disputeProposalTtlSeconds: number;
  };
}

/** The terms the current contract enforces (LaunchSettlementSchedule and AgroasysEscrow constants). */
export const AGROASYS_LAUNCH_TEMPLATE_V1: SettlementTemplate = Object.freeze({
  schemaVersion: SETTLEMENT_TEMPLATE_SCHEMA_VERSION,
  templateId: 'agroasys.launch',
  version: 1,
  asset: Object.freeze({ symbol: 'USDC', decimals: 6, quantumBaseUnits: '10000' }),
  milestones: Object.freeze([
    Object.freeze({ id: 'stage1', releaseBps: 6_000, deductsSupplierFee: true }),
    Object.freeze({ id: 'final', releaseBps: 4_000, deductsSupplierFee: false }),
  ]) as SettlementTemplateMilestone[],
  fees: Object.freeze({
    buyerBps: 50,
    supplierBps: 50,
    fixedSupportFeeBaseUnits: '4000000',
    rounding: 'half-up-per-quantum' as const,
  }),
  windows: Object.freeze({
    standardInspectionSeconds: 72 * 3600,
    packagedLocalInspectionSeconds: 48 * 3600,
    lockTimeoutSeconds: 7 * 86_400,
    inTransitTimeoutSeconds: 14 * 86_400,
    disputeProposalTtlSeconds: 7 * 86_400,
  }),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the template's canonical JSON, as a 0x-prefixed hex string. */
export function settlementTemplateHash(template: SettlementTemplate): string {
  return sha256(toUtf8Bytes(canonicalJson(template)));
}

const isBps = (value: number) => Number.isInteger(value) && value >= 0 && value <= 10_000;
const isPositiveIntegerString = (value: string) => /^[1-9][0-9]*$/u.test(value);
const isNonNegativeIntegerString = (value: string) => /^(0|[1-9][0-9]*)$/u.test(value);

/** Returns every reason the template is not acceptable; empty when valid. */
export function settlementTemplateProblems(template: SettlementTemplate): string[] {
  const problems: string[] = [];
  if (template.schemaVersion !== SETTLEMENT_TEMPLATE_SCHEMA_VERSION)
    problems.push('unknown schemaVersion');
  if (!/^[a-z][a-z0-9.-]{1,62}$/u.test(template.templateId))
    problems.push('templateId must be lower-case');
  if (!Number.isInteger(template.version) || template.version < 1)
    problems.push('version must be a positive integer');
  if (!Number.isInteger(template.asset.decimals) || template.asset.decimals < 0)
    problems.push('asset decimals');
  if (!isPositiveIntegerString(template.asset.quantumBaseUnits))
    problems.push('quantum must be a positive integer');

  const milestones = template.milestones;
  if (milestones.length < 1) problems.push('at least one milestone is required');
  if (new Set(milestones.map((milestone) => milestone.id)).size !== milestones.length) {
    problems.push('milestone ids must be unique');
  }
  if (milestones.some((milestone) => !isBps(milestone.releaseBps) || milestone.releaseBps === 0)) {
    problems.push('every milestone needs a release share between 1 and 10000 bps');
  }
  if (milestones.reduce((total, milestone) => total + milestone.releaseBps, 0) !== 10_000) {
    problems.push('milestone release shares must sum to exactly 10000 bps');
  }
  if (milestones.filter((milestone) => milestone.deductsSupplierFee).length !== 1) {
    problems.push('exactly one milestone must carry the supplier fee');
  }
  if (!isBps(template.fees.buyerBps) || !isBps(template.fees.supplierBps)) problems.push('fee bps');
  if (template.fees.supplierBps >= 10_000) problems.push('supplier fee must be below 100%');
  if (!isNonNegativeIntegerString(template.fees.fixedSupportFeeBaseUnits))
    problems.push('support fee');
  if (template.fees.rounding !== 'half-up-per-quantum') problems.push('unsupported rounding');
  for (const [name, seconds] of Object.entries(template.windows)) {
    if (!Number.isInteger(seconds) || seconds <= 0)
      problems.push(`${name} must be a positive number of seconds`);
  }
  return problems;
}

export interface SettlementSchedule {
  goodsAmount: bigint;
  buyerFee: bigint;
  supplierFee: bigint;
  /** Net supplier release per milestone, in template order. */
  supplierTranches: bigint[];
  /** Buyer fee + supplier fee + fixed support fee. */
  platformFeesAmount: bigint;
}

const roundedShare = (quanta: bigint, bps: number, quantum: bigint) =>
  ((quanta * BigInt(bps) + HALF_BPS) / BPS) * quantum;

/**
 * Computes the schedule for a goods amount in base units. Every milestone but
 * the last is rounded half up to a quantum; the last takes the remainder, so
 * the milestones always sum to the goods amount exactly.
 */
export function computeSettlementSchedule(
  template: SettlementTemplate,
  goodsAmount: bigint,
): SettlementSchedule {
  const problems = settlementTemplateProblems(template);
  if (problems.length > 0) throw new Error(`Invalid settlement template: ${problems.join('; ')}`);
  const quantum = BigInt(template.asset.quantumBaseUnits);
  if (goodsAmount <= 0n || goodsAmount % quantum !== 0n) {
    throw new Error('Goods amount must be a positive multiple of the template quantum');
  }
  const quanta = goodsAmount / quantum;
  const buyerFee = roundedShare(quanta, template.fees.buyerBps, quantum);
  const supplierFee = roundedShare(quanta, template.fees.supplierBps, quantum);

  const gross: bigint[] = [];
  let allocated = 0n;
  template.milestones.forEach((milestone, index) => {
    const share =
      index === template.milestones.length - 1
        ? goodsAmount - allocated
        : roundedShare(quanta, milestone.releaseBps, quantum);
    gross.push(share);
    allocated += share;
  });
  const feeIndex = template.milestones.findIndex((milestone) => milestone.deductsSupplierFee);
  if (gross[feeIndex] < supplierFee)
    throw new Error('Supplier fee exceeds the milestone that carries it');
  const supplierTranches = gross.map((share, index) =>
    index === feeIndex ? share - supplierFee : share,
  );
  // AgroasysEscrow rejects any zero tranche (EscrowTranchesMustBeGreaterThan0).
  if (supplierTranches.some((amount) => amount <= 0n)) {
    throw new Error('Every milestone must release a positive supplier amount');
  }

  return {
    goodsAmount,
    buyerFee,
    supplierFee,
    supplierTranches,
    platformFeesAmount: buyerFee + supplierFee + BigInt(template.fees.fixedSupportFeeBaseUnits),
  };
}

/**
 * Whether the supplied amounts are exactly the template's schedule for some
 * goods amount, as AgroasysEscrow admits it: LaunchSettlementSchedule.isValid
 * plus every tranche being positive (EscrowTranchesMustBeGreaterThan0).
 * Amounts must be whole quanta, and the goods amount is recovered from the net
 * supplier total (it is one of two candidates because the supplier fee is
 * rounded half up).
 */
export function isSettlementScheduleValid(
  template: SettlementTemplate,
  platformFeesAmount: bigint,
  supplierTranches: bigint[],
): boolean {
  if (settlementTemplateProblems(template).length > 0) return false;
  if (supplierTranches.length !== template.milestones.length) return false;
  if (supplierTranches.some((amount) => amount <= 0n)) return false;
  const quantum = BigInt(template.asset.quantumBaseUnits);
  if (
    [platformFeesAmount, ...supplierTranches].some(
      (amount) => amount < 0n || amount % quantum !== 0n,
    )
  ) {
    return false;
  }
  const netQuanta = supplierTranches.reduce((total, amount) => total + amount, 0n) / quantum;
  const candidate = (netQuanta * BPS) / (BPS - BigInt(template.fees.supplierBps));
  return [candidate, candidate + 1n].some((goodsQuanta) => {
    if (goodsQuanta <= 0n) return false;
    let schedule: SettlementSchedule;
    try {
      schedule = computeSettlementSchedule(template, goodsQuanta * quantum);
    } catch {
      return false;
    }
    return (
      schedule.platformFeesAmount === platformFeesAmount &&
      schedule.supplierTranches.every((amount, index) => amount === supplierTranches[index])
    );
  });
}
