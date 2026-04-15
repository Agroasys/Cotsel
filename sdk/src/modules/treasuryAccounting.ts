/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type TreasuryAccountingState =
  | 'HELD'
  | 'ALLOCATED_TO_SWEEP'
  | 'SWEPT'
  | 'HANDED_OFF'
  | 'REALIZED'
  | 'EXCEPTION';

export type SweepBatchAllocationStatus = 'ALLOCATED' | 'RELEASED';
export type PartnerHandoffStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'COMPLETED'
  | 'FAILED';
export type RevenueRealizationStatus = 'REALIZED' | 'REVERSED';
export type FiatDepositState = 'PENDING' | 'FUNDED' | 'PARTIAL' | 'REVERSED' | 'FAILED';
export type BankPayoutState = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export interface TreasuryAccountingProjectionFacts {
  allocationStatus: SweepBatchAllocationStatus | null;
  allocatedAmountRaw: string | null;
  partnerReference: string | null;
  partnerHandoffStatus: PartnerHandoffStatus | null;
  matchedSweepTxHash: string | null;
  matchedSweptAt: Date | null;
  latestFiatDepositState: FiatDepositState | null;
  latestBankPayoutState: BankPayoutState | null;
  revenueRealizationStatus: RevenueRealizationStatus | null;
  realizedAt: Date | null;
}

export interface TreasuryAccountingProjection {
  accountingState: TreasuryAccountingState;
  accountingStateReason: string;
}

export function projectTreasuryAccountingState(
  facts: TreasuryAccountingProjectionFacts,
): TreasuryAccountingProjection {
  if (facts.revenueRealizationStatus === 'REALIZED' && facts.realizedAt) {
    return {
      accountingState: 'REALIZED',
      accountingStateReason: 'Controlled revenue realization recorded',
    };
  }

  if (facts.partnerHandoffStatus === 'FAILED') {
    return {
      accountingState: 'EXCEPTION',
      accountingStateReason: 'External handoff reported failure',
    };
  }

  if (facts.latestBankPayoutState === 'REJECTED') {
    return {
      accountingState: 'EXCEPTION',
      accountingStateReason: 'Latest bank settlement evidence is rejected',
    };
  }

  if (facts.latestFiatDepositState === 'FAILED') {
    return {
      accountingState: 'EXCEPTION',
      accountingStateReason: 'Latest fiat deposit evidence reported failure',
    };
  }

  if (facts.latestFiatDepositState === 'REVERSED') {
    return {
      accountingState: 'EXCEPTION',
      accountingStateReason: 'Latest fiat deposit evidence reported reversal',
    };
  }

  if (facts.partnerReference && facts.partnerHandoffStatus) {
    const reasonByStatus: Record<PartnerHandoffStatus, string> = {
      CREATED: 'External handoff record created; awaiting submission evidence',
      SUBMITTED: 'External handoff submitted; awaiting acknowledgment',
      ACKNOWLEDGED: 'External handoff acknowledged by execution counterparty',
      COMPLETED: 'External handoff completed; awaiting controlled realization',
      FAILED: 'External handoff reported failure',
    };

    return {
      accountingState: 'HANDED_OFF',
      accountingStateReason: reasonByStatus[facts.partnerHandoffStatus],
    };
  }

  if (facts.matchedSweepTxHash && facts.matchedSweptAt) {
    return {
      accountingState: 'SWEPT',
      accountingStateReason: 'Matched on-chain treasury claim recorded',
    };
  }

  if (facts.allocationStatus === 'ALLOCATED' && facts.allocatedAmountRaw) {
    return {
      accountingState: 'ALLOCATED_TO_SWEEP',
      accountingStateReason: 'Ledger entry is allocated to a sweep batch',
    };
  }

  return {
    accountingState: 'HELD',
    accountingStateReason: 'Treasury-earned fee remains held and unallocated',
  };
}
