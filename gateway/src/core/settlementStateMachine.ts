/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { SettlementEventType, SettlementExecutionStatus } from './settlementStore';

const EXECUTION_TRANSITIONS: Record<SettlementExecutionStatus, SettlementExecutionStatus[]> = {
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
  broadcast_unknown: ['confirmation_pending', 'confirmed', 'reverted', 'replaced', 'failed'],
  confirmation_pending: ['confirmed', 'reverted', 'replaced'],
  submitted: ['confirmation_pending', 'confirmed', 'reverted', 'replaced', 'failed', 'rejected'],
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

  if (!EXECUTION_TRANSITIONS[current].includes(next)) {
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
