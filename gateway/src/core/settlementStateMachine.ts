/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { SettlementEventType, SettlementExecutionStatus } from './settlementStore';

const EXECUTION_TRANSITIONS: Record<SettlementExecutionStatus, SettlementExecutionStatus[]> = {
  pending: ['accepted', 'queued', 'submitted', 'failed', 'rejected'],
  accepted: ['queued', 'submitted', 'failed', 'rejected'],
  queued: ['submitted', 'failed', 'rejected'],
  submitted: ['confirmed', 'failed', 'rejected'],
  confirmed: ['confirmed'],
  failed: ['failed'],
  rejected: ['rejected'],
};

const RECONCILIATION_EVENT_TYPES = new Set<SettlementEventType>(['reconciled', 'drift_detected']);

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
