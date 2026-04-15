import {
  AccountingPeriodStatus,
  BankPayoutState,
  PartnerHandoffStatus,
  RevenueRealizationStatus,
  SweepBatchStatus,
} from '../types';

const ACCOUNTING_PERIOD_TRANSITIONS: Record<AccountingPeriodStatus, AccountingPeriodStatus[]> = {
  OPEN: ['PENDING_CLOSE'],
  PENDING_CLOSE: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

const SWEEP_BATCH_TRANSITIONS: Record<SweepBatchStatus, SweepBatchStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'VOID'],
  PENDING_APPROVAL: ['DRAFT', 'APPROVED', 'VOID'],
  APPROVED: ['EXECUTED', 'VOID'],
  EXECUTED: ['HANDED_OFF', 'CLOSED'],
  HANDED_OFF: ['CLOSED'],
  CLOSED: [],
  VOID: [],
};

export function assertAccountingPeriodTransition(
  current: AccountingPeriodStatus,
  next: AccountingPeriodStatus,
): void {
  if (!ACCOUNTING_PERIOD_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid accounting period transition: ${current} -> ${next}`);
  }
}

export function assertSweepBatchTransition(
  current: SweepBatchStatus,
  next: SweepBatchStatus,
): void {
  if (!SWEEP_BATCH_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid sweep batch transition: ${current} -> ${next}`);
  }
}

export function assertBatchAllocationAllowed(params: {
  periodStatus: AccountingPeriodStatus;
  batchStatus: SweepBatchStatus;
}): void {
  if (params.periodStatus !== 'OPEN') {
    throw new Error(
      `Sweep allocation requires an OPEN accounting period; received ${params.periodStatus}`,
    );
  }

  if (params.batchStatus !== 'DRAFT') {
    throw new Error(`Sweep allocation requires a DRAFT batch; received ${params.batchStatus}`);
  }
}

export function assertBatchExecutionMatchable(params: {
  batchStatus: SweepBatchStatus;
  payoutReceiverAddress: string | null;
  assetSymbol: string;
  expectedTotalRaw: string;
  allocatedTotalRaw: string;
  observedTxHash: string;
  observedPayoutReceiver: string;
  observedAmountRaw: string;
}): void {
  if (params.batchStatus !== 'APPROVED') {
    throw new Error(
      `Matched sweep execution requires batch status APPROVED; received ${params.batchStatus}`,
    );
  }

  if (!params.payoutReceiverAddress) {
    throw new Error('Matched sweep execution requires a recorded payout receiver address');
  }

  if (params.assetSymbol.trim().toUpperCase() !== 'USDC') {
    throw new Error(
      `Matched sweep execution only supports the escrow USDC asset; received ${params.assetSymbol}`,
    );
  }

  if (params.expectedTotalRaw !== params.allocatedTotalRaw) {
    throw new Error('Sweep batch expected total does not match allocated amount total');
  }

  if (params.observedAmountRaw !== params.allocatedTotalRaw) {
    throw new Error('Observed treasury claim amount does not match allocated amount total');
  }

  if (
    params.observedPayoutReceiver.trim().toLowerCase() !==
    params.payoutReceiverAddress.trim().toLowerCase()
  ) {
    throw new Error('Observed treasury claim destination does not match the batch payout receiver');
  }

  if (!params.observedTxHash.trim()) {
    throw new Error('Matched sweep execution requires an observed treasury claim tx hash');
  }
}

export function assertSweepBatchRoleSeparation(params: {
  nextStatus: SweepBatchStatus;
  actor: string;
  createdBy: string;
  approvalRequestedBy: string | null;
  approvedBy: string | null;
  executedBy: string | null;
}): void {
  if (
    params.nextStatus === 'APPROVED' &&
    [params.createdBy, params.approvalRequestedBy].includes(params.actor)
  ) {
    throw new Error('Sweep batch approval requires a different actor than preparation');
  }

  if (params.nextStatus === 'EXECUTED' && params.approvedBy === params.actor) {
    throw new Error('Sweep batch execution requires a different actor than approval');
  }

  if (
    params.nextStatus === 'CLOSED' &&
    [params.approvedBy, params.executedBy].includes(params.actor)
  ) {
    throw new Error('Sweep batch close requires a different actor than approval or execution');
  }
}

export function assertRealizationAllowed(params: {
  batchStatus: SweepBatchStatus | null;
  partnerHandoffStatus: PartnerHandoffStatus | null;
  bankPayoutState: BankPayoutState | null;
  revenueRealizationStatus: RevenueRealizationStatus | null;
}): void {
  if (!params.batchStatus || !['HANDED_OFF', 'CLOSED'].includes(params.batchStatus)) {
    throw new Error('Revenue realization requires a handed-off or closed sweep batch');
  }

  if (params.partnerHandoffStatus !== 'COMPLETED') {
    throw new Error('Revenue realization requires completed external handoff evidence');
  }

  if (params.bankPayoutState !== 'CONFIRMED') {
    throw new Error('Revenue realization requires confirmed bank settlement evidence');
  }

  if (params.revenueRealizationStatus === 'REALIZED') {
    throw new Error('Ledger entry is already realized');
  }

  if (params.revenueRealizationStatus === 'REVERSED') {
    throw new Error('Ledger entry has a reversed realization and needs controlled remediation');
  }
}
