/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TransactionFinalityPosition } from '@agroasys/sdk';
import type { GaslessTransactionOutcomeStatus } from './gaslessTransactionOutcomeStore';
import type { SettlementExecutionStatus } from './settlementStoreTypes';

const UNKNOWN: TransactionFinalityPosition = { state: 'unknown', final: false };
const NEVER_BROADCAST: TransactionFinalityPosition = { state: 'failed', final: true };

/**
 * WP-2 H-02. The shared finality position each persisted settlement execution
 * status claims; `null` before any transaction exists. `confirmed` and
 * `reverted` are only written with dual-provider finalized evidence (or a
 * finalized Oracle position), so they are final. Nothing produces `replaced`
 * with finalized evidence yet, so it is not treated as final.
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
