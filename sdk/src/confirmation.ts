/**
 * SPDX-License-Identifier: Apache-2.0
 */
export const SETTLEMENT_CONFIRMATION_STAGES = ['INDEXED', 'SAFE', 'FINALIZED'] as const;

export type SettlementConfirmationStage = (typeof SETTLEMENT_CONFIRMATION_STAGES)[number];

export interface SettlementConfirmationHeads {
  latestBlockNumber: number;
  safeBlockNumber: number | null;
  finalizedBlockNumber: number | null;
}

export interface SettlementConfirmationState extends SettlementConfirmationHeads {
  eventBlockNumber: number;
  stage: SettlementConfirmationStage;
}

function assertBlockNumber(name: string, value: number | null): void {
  if (value === null) {
    return;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer when provided`);
  }
}

export function resolveSettlementConfirmationStage(
  eventBlockNumber: number,
  heads: SettlementConfirmationHeads,
): SettlementConfirmationState {
  assertBlockNumber('eventBlockNumber', eventBlockNumber);
  assertBlockNumber('latestBlockNumber', heads.latestBlockNumber);
  assertBlockNumber('safeBlockNumber', heads.safeBlockNumber);
  assertBlockNumber('finalizedBlockNumber', heads.finalizedBlockNumber);

  if (eventBlockNumber > heads.latestBlockNumber) {
    throw new Error(
      `Event block ${eventBlockNumber} cannot be ahead of latest block ${heads.latestBlockNumber}`,
    );
  }

  let stage: SettlementConfirmationStage = 'INDEXED';

  if (heads.finalizedBlockNumber !== null && eventBlockNumber <= heads.finalizedBlockNumber) {
    stage = 'FINALIZED';
  } else if (heads.safeBlockNumber !== null && eventBlockNumber <= heads.safeBlockNumber) {
    stage = 'SAFE';
  }

  return {
    eventBlockNumber,
    latestBlockNumber: heads.latestBlockNumber,
    safeBlockNumber: heads.safeBlockNumber,
    finalizedBlockNumber: heads.finalizedBlockNumber,
    stage,
  };
}

export function isWorkflowConfirmationStage(stage: SettlementConfirmationStage): boolean {
  return stage === 'SAFE' || stage === 'FINALIZED';
}

export function isTreasuryConfirmationStage(stage: SettlementConfirmationStage): boolean {
  return stage === 'FINALIZED';
}
