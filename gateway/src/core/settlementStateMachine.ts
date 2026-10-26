/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { canTransitionTransactionFinality } from '@agroasys/sdk';
import { GatewayError } from '../errors';
import { SETTLEMENT_EXECUTION_FINALITY } from './settlementFinality';
import { SettlementEventType, SettlementExecutionStatus } from './settlementStore';

/**
 * Once a transaction may have reached the network it can no longer become
 * `failed` or `rejected` (never broadcast); it must resolve on-chain or stay
 * an owned unknown. Every edge must also be legal in the shared finality model.
 */
export const EXECUTION_TRANSITIONS: Record<SettlementExecutionStatus, SettlementExecutionStatus[]> =
  {
    pending: [
      'accepted',
      'queued',
      'broadcast_unknown',
      'confirmation_pending',
      'submitted',
      'failed',
      'rejected',
    ],
    accepted: [
      'queued',
      'broadcast_unknown',
      'confirmation_pending',
      'submitted',
      'failed',
      'rejected',
    ],
    queued: ['broadcast_unknown', 'confirmation_pending', 'submitted', 'failed', 'rejected'],
    broadcast_unknown: ['confirmation_pending', 'confirmed', 'reverted', 'replaced'],
    confirmation_pending: ['confirmed', 'reverted', 'replaced'],
    submitted: ['confirmation_pending', 'confirmed', 'reverted', 'replaced'],
    confirmed: ['confirmed'],
    reverted: ['reverted'],
    replaced: ['replaced'],
    failed: ['failed'],
    rejected: ['rejected'],
  };

const RECONCILIATION_EVENT_TYPES = new Set<SettlementEventType>(['reconciled', 'drift_detected']);
const NON_MUTATING_EXECUTION_EVENT_TYPES = new Set<SettlementEventType>(['simulation_completed']);

export function validateExecutionTransition(
  current: SettlementExecutionStatus,
  next: SettlementExecutionStatus,
  eventType: SettlementEventType,
): void {
  if (eventType === 'chain_evidence_orphaned') {
    if (
      !['confirmed', 'reverted', 'confirmation_pending'].includes(current) ||
      next !== 'confirmation_pending'
    ) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Chain canonicality loss must retain the original operation for reconciliation',
      );
    }
    return;
  }
  if (RECONCILIATION_EVENT_TYPES.has(eventType)) {
    if (current !== 'confirmed') {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Reconciliation events require a confirmed settlement handoff',
        {
          currentExecutionStatus: current,
          eventType,
        },
      );
    }

    if (next !== current) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Reconciliation events cannot mutate settlement execution state',
        {
          currentExecutionStatus: current,
          nextExecutionStatus: next,
          eventType,
        },
      );
    }
    return;
  }

  if (NON_MUTATING_EXECUTION_EVENT_TYPES.has(eventType)) {
    if (next !== current) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Execution telemetry events cannot mutate settlement execution state',
        {
          currentExecutionStatus: current,
          nextExecutionStatus: next,
          eventType,
        },
      );
    }
    return;
  }

  if (current === next) {
    return;
  }

  const from = SETTLEMENT_EXECUTION_FINALITY[current];
  const to = SETTLEMENT_EXECUTION_FINALITY[next];
  if (
    !EXECUTION_TRANSITIONS[current].includes(next) ||
    (from && to && !canTransitionTransactionFinality(from, to))
  ) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Settlement execution event violates the handoff state machine',
      {
        currentExecutionStatus: current,
        nextExecutionStatus: next,
        eventType,
      },
    );
  }
}
