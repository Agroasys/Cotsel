/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TransactionFinalityPosition } from '@agroasys/sdk';
import type { GaslessTransactionOutcomeStatus } from './gaslessTransactionOutcomeStore';
import type { SettlementEventType, SettlementExecutionStatus } from './settlementStoreTypes';

const UNKNOWN: TransactionFinalityPosition = { state: 'unknown', final: false };
const NEVER_BROADCAST: TransactionFinalityPosition = { state: 'failed', final: true };

/**
 * WP-2 H-02. The shared finality position each persisted settlement execution
 * status claims; `null` before any transaction exists. `confirmed` and
 * `reverted` are only written by the gateway's own verified paths, with
 * dual-provider finalized evidence or a finalized Oracle position, so they are
 * final. The service ingress cannot assert them (see
 * `isServiceReportableExecution`). Nothing produces `replaced` with
 * finalized evidence yet, so it is not treated as final.
 */
export const SETTLEMENT_EXECUTION_FINALITY: Record<
  SettlementExecutionStatus,
  TransactionFinalityPosition | null
> = {
  pending: null,
  accepted: null,
  queued: null,
  broadcast_unknown: UNKNOWN,
  confirmation_pending: UNKNOWN,
  submitted: { state: 'submitted', final: false },
  confirmed: { state: 'finalized', final: true },
  reverted: { state: 'reverted', final: true },
  replaced: { state: 'replaced', final: false },
  failed: NEVER_BROADCAST,
  rejected: NEVER_BROADCAST,
};

/** The same mapping for the gasless transaction outcome ledger. */
export const GASLESS_OUTCOME_FINALITY: Record<
  GaslessTransactionOutcomeStatus,
  TransactionFinalityPosition
> = {
  // Persisted before the send, so a crash leaves the broadcast ambiguous.
  broadcast_pending: UNKNOWN,
  broadcast_unknown: UNKNOWN,
  confirmation_pending: UNKNOWN,
  confirmed: { state: 'finalized', final: true },
  reverted: { state: 'reverted', final: true },
  replaced: { state: 'replaced', final: false },
  failed: NEVER_BROADCAST,
};

/** Chain outcomes only the gateway's verified finality paths may record. */
const GATEWAY_VERIFIED_EXECUTION_STATUSES = new Set<SettlementExecutionStatus>([
  'confirmed',
  'reverted',
  'replaced',
]);
/** Events that restate the current status; the state machine forbids them from changing it. */
const NON_MUTATING_EVENT_TYPES = new Set<SettlementEventType>(['reconciled', 'drift_detected']);

/**
 * A service caller reports what it saw but cannot carry finality evidence, so
 * it may not move a handoff to a chain outcome the model treats as final.
 */
export function isServiceReportableExecution(
  eventType: SettlementEventType,
  executionStatus: SettlementExecutionStatus,
): boolean {
  return (
    !GATEWAY_VERIFIED_EXECUTION_STATUSES.has(executionStatus) ||
    NON_MUTATING_EVENT_TYPES.has(eventType)
  );
}
