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

export type TransitionActorRole = 'MAKER' | 'CHECKER' | 'EXECUTOR' | 'CLOSER';

export interface TransitionActorRecord {
  actor: string;
  actor_role: TransitionActorRole;
}

/**
 * Only the transitions that carry a separation-of-duty role are attributed.
 * Sending a batch back to DRAFT, voiding it, or reopening a period changes
 * state without granting anything, and the role that matters is re-recorded on
 * the next transition that does.
 */
const SWEEP_BATCH_ACTOR_ROLES: Partial<Record<SweepBatchStatus, TransitionActorRole>> = {
  PENDING_APPROVAL: 'MAKER',
  APPROVED: 'CHECKER',
  EXECUTED: 'EXECUTOR',
  HANDED_OFF: 'EXECUTOR',
  CLOSED: 'CLOSER',
};

const ACCOUNTING_PERIOD_ACTOR_ROLES: Partial<Record<AccountingPeriodStatus, TransitionActorRole>> =
  {
    PENDING_CLOSE: 'MAKER',
    CLOSED: 'CHECKER',
  };

export function sweepBatchActorRole(status: SweepBatchStatus): TransitionActorRole | null {
  return SWEEP_BATCH_ACTOR_ROLES[status] ?? null;
}

export function accountingPeriodActorRole(
  status: AccountingPeriodStatus,
): TransitionActorRole | null {
  return ACCOUNTING_PERIOD_ACTOR_ROLES[status] ?? null;
}

function heldRoles(chain: TransitionActorRecord[], actor: string): Set<TransitionActorRole> {
  const roles = new Set<TransitionActorRole>();

  for (const record of chain) {
    if (record.actor === actor) {
      roles.add(record.actor_role);
    }
  }

  return roles;
}

/**
 * Separation of duty is decided against the whole recorded chain, not the
 * latest `*_by` column. A batch that returns to DRAFT and is re-prepared by a
 * second maker still remembers the first, so an earlier maker cannot come back
 * as the approver once someone else has taken their column over.
 */
export function assertSweepBatchRoleSeparation(params: {
  nextStatus: SweepBatchStatus;
  actor: string;
  createdBy: string;
  approvalRequestedBy: string | null;
  approvedBy: string | null;
  executedBy: string | null;
  transitionChain?: TransitionActorRecord[];
}): void {
  const held = heldRoles(params.transitionChain ?? [], params.actor);

  if (
    params.nextStatus === 'APPROVED' &&
    ([params.createdBy, params.approvalRequestedBy].includes(params.actor) || held.has('MAKER'))
  ) {
    throw new Error('Sweep batch approval requires a different actor than preparation');
  }

  if (
    params.nextStatus === 'EXECUTED' &&
    (params.approvedBy === params.actor || held.has('CHECKER'))
  ) {
    throw new Error('Sweep batch execution requires a different actor than approval');
  }

  if (
    params.nextStatus === 'CLOSED' &&
    ([params.approvedBy, params.executedBy].includes(params.actor) ||
      held.has('CHECKER') ||
      held.has('EXECUTOR'))
  ) {
    throw new Error('Sweep batch close requires a different actor than approval or execution');
  }
}

/**
 * Closing an accounting period freezes a financial result, so it carries the
 * same two-person rule the sweep batches already had: whoever asked for the
 * close cannot also grant it.
 */
export function assertAccountingPeriodRoleSeparation(params: {
  nextStatus: AccountingPeriodStatus;
  actor: string;
  createdBy: string;
  transitionChain?: TransitionActorRecord[];
}): void {
  if (params.nextStatus !== 'CLOSED') {
    return;
  }

  const held = heldRoles(params.transitionChain ?? [], params.actor);

  if (held.has('MAKER') || params.createdBy === params.actor) {
    throw new Error(
      'Accounting period close requires a different actor than the close request or period creation',
    );
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
