import { projectLedgerEntryAccountingState } from '../src/core/accountingStateProjection';
import { LedgerEntryAccountingFacts } from '../src/types';

function makeFacts(
  overrides: Partial<LedgerEntryAccountingFacts> = {},
): LedgerEntryAccountingFacts {
  return {
    ledger_entry_id: 1,
    trade_id: 'trade-1',
    component_type: 'PLATFORM_FEE',
    amount_raw: '1000',
    allocated_amount_raw: null,
    earned_at: new Date('2026-04-15T00:00:00.000Z'),
    payout_state: 'PENDING_REVIEW',
    accounting_period_id: null,
    accounting_period_key: null,
    accounting_period_status: null,
    sweep_batch_id: null,
    sweep_batch_status: null,
    allocation_status: null,
    matched_sweep_tx_hash: null,
    matched_sweep_block_number: null,
    matched_swept_at: null,
    matched_treasury_identity: null,
    matched_payout_receiver: null,
    matched_claim_amount_raw: null,
    partner_handoff_id: null,
    partner_name: null,
    partner_reference: null,
    partner_handoff_status: null,
    partner_completed_at: null,
    latest_fiat_deposit_state: null,
    latest_bank_payout_state: null,
    revenue_realization_status: null,
    realized_at: null,
    ...overrides,
  };
}

describe('projectLedgerEntryAccountingState', () => {
  it('defaults to HELD for earned but unallocated entries', () => {
    const projection = projectLedgerEntryAccountingState(makeFacts());

    expect(projection.accounting_state).toBe('HELD');
    expect(projection.accounting_state_reason).toContain('held');
  });

  it('shows ALLOCATED_TO_SWEEP once entry is batched', () => {
    const projection = projectLedgerEntryAccountingState(
      makeFacts({
        sweep_batch_id: 42,
        sweep_batch_status: 'DRAFT',
        allocation_status: 'ALLOCATED',
        allocated_amount_raw: '1000',
      }),
    );

    expect(projection.accounting_state).toBe('ALLOCATED_TO_SWEEP');
  });

  it('shows SWEPT only after matched on-chain sweep evidence exists', () => {
    const projection = projectLedgerEntryAccountingState(
      makeFacts({
        sweep_batch_id: 42,
        sweep_batch_status: 'EXECUTED',
        allocation_status: 'ALLOCATED',
        allocated_amount_raw: '1000',
        matched_sweep_tx_hash: '0xabc',
        matched_swept_at: new Date('2026-04-15T01:00:00.000Z'),
      }),
    );

    expect(projection.accounting_state).toBe('SWEPT');
  });

  it('shows HANDED_OFF once a real partner reference exists', () => {
    const projection = projectLedgerEntryAccountingState(
      makeFacts({
        sweep_batch_id: 42,
        sweep_batch_status: 'HANDED_OFF',
        allocation_status: 'ALLOCATED',
        allocated_amount_raw: '1000',
        matched_sweep_tx_hash: '0xabc',
        matched_swept_at: new Date('2026-04-15T01:00:00.000Z'),
        partner_handoff_id: 9,
        partner_reference: 'partner-ref-1',
        partner_handoff_status: 'ACKNOWLEDGED',
      }),
    );

    expect(projection.accounting_state).toBe('HANDED_OFF');
  });

  it('shows REALIZED only when controlled realization exists', () => {
    const projection = projectLedgerEntryAccountingState(
      makeFacts({
        revenue_realization_status: 'REALIZED',
        realized_at: new Date('2026-04-15T03:00:00.000Z'),
      }),
    );

    expect(projection.accounting_state).toBe('REALIZED');
  });

  it('prioritizes EXCEPTION over swept or handed off states', () => {
    const projection = projectLedgerEntryAccountingState(
      makeFacts({
        sweep_batch_id: 42,
        sweep_batch_status: 'HANDED_OFF',
        allocation_status: 'ALLOCATED',
        allocated_amount_raw: '1000',
        matched_sweep_tx_hash: '0xabc',
        matched_swept_at: new Date('2026-04-15T01:00:00.000Z'),
        partner_handoff_id: 9,
        partner_reference: 'partner-ref-1',
        partner_handoff_status: 'FAILED',
      }),
    );

    expect(projection.accounting_state).toBe('EXCEPTION');
    expect(projection.accounting_state_reason).toContain('failure');
  });
});
