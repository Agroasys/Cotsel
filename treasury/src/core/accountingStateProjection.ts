import { projectTreasuryAccountingState } from '@agroasys/sdk';
import { LedgerEntryAccountingFacts, LedgerEntryAccountingProjection } from '../types';
import { toSdkPartnerHandoffStatus } from './providerHandoffAuthority';

export function projectLedgerEntryAccountingState(
  facts: LedgerEntryAccountingFacts,
): LedgerEntryAccountingProjection {
  const projection = projectTreasuryAccountingState({
    allocationStatus: facts.allocation_status,
    allocatedAmountRaw: facts.allocated_amount_raw,
    partnerReference: facts.partner_reference,
    partnerHandoffStatus: facts.partner_handoff_status
      ? toSdkPartnerHandoffStatus(facts.partner_handoff_status)
      : null,
    matchedSweepTxHash: facts.matched_sweep_tx_hash,
    matchedSweptAt: facts.matched_swept_at,
    latestFiatDepositState: facts.latest_fiat_deposit_state,
    latestBankPayoutState: facts.latest_bank_payout_state,
    revenueRealizationStatus: facts.revenue_realization_status,
    realizedAt: facts.realized_at,
  });

  return {
    ...facts,
    accounting_state: projection.accountingState,
    accounting_state_reason: projection.accountingStateReason,
  };
}
