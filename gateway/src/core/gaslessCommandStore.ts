/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import { GatewayError } from '../errors';
import type { AuditLogEntry } from './auditLogStore';

export const GASLESS_COMMAND_STATUSES = [
  'pending',
  'leased',
  'outcome_pending',
  'completed',
  'failed',
  'dead_letter',
] as const;

export type GaslessCommandStatus = (typeof GASLESS_COMMAND_STATUSES)[number];
export type GaslessCommandResourceType = 'settlement_handoff' | 'platform_transfer';

export class GaslessCommandCapacityError extends GatewayError {
  constructor(maxQueueDepth: number) {
    super(503, 'UPSTREAM_UNAVAILABLE', 'Durable gasless command queue is at capacity', {
      maxQueueDepth,
    });
    this.name = 'GaslessCommandCapacityError';
  }
}

export interface CreateGaslessCommandInput {
  applicationRequestId: string;
  intentKey: string;
  resourceType: GaslessCommandResourceType;
  resourceId: string;
  operation: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  maxQueueDepth: number;
  nextAttemptAt: string;
}

export interface GaslessCommandRecord extends Omit<CreateGaslessCommandInput, 'maxQueueDepth'> {
  commandId: string;
  status: GaslessCommandStatus;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  transactionHash: string | null;
  result: unknown | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GaslessCommandQueueStats {
  pending: number;
  leased: number;
  outcomePending: number;
  deadLetter: number;
  expiredLeases: number;
  oldestPendingAt: string | null;
}

export type GaslessCommandDeadLetter = Omit<GaslessCommandRecord, 'payload' | 'result'>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function createGaslessCommandIntentKey(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export interface GaslessCommandStore {
  enqueueCommand(input: CreateGaslessCommandInput): Promise<GaslessCommandRecord>;
  getCommand(commandId: string): Promise<GaslessCommandRecord | null>;
  getByApplicationRequestId(applicationRequestId: string): Promise<GaslessCommandRecord | null>;
  claimDueCommand(
    leaseOwner: string,
    attemptedAt: string,
    leaseExpiresAt: string,
  ): Promise<GaslessCommandRecord | null>;
  renewLease(commandId: string, leaseOwner: string, leaseExpiresAt: string): Promise<boolean>;
  markCompleted(
    commandId: string,
    leaseOwner: string,
    completedAt: string,
    result: unknown,
    transactionHash?: string | null,
  ): Promise<boolean>;
  markOutcomePending(
    commandId: string,
    leaseOwner: string,
    completedAt: string,
    transactionHash: string,
  ): Promise<boolean>;
  markFailed(
    commandId: string,
    leaseOwner: string,
    completedAt: string,
    errorCode: string,
    errorDetail: string,
    nextAttemptAt: string,
    deadLetter: boolean,
  ): Promise<boolean>;
  resolveTransactionOutcome(
    applicationRequestId: string,
    transactionHash: string,
    outcomeStatus: 'broadcast_unknown' | 'confirmation_pending' | 'confirmed' | 'reverted',
    observedAt: string,
  ): Promise<boolean>;
  listDeadLetters(limit: number): Promise<GaslessCommandDeadLetter[]>;
  redriveDeadLetter(
    commandId: string,
    requestedAt: string,
    auditEntry: AuditLogEntry,
  ): Promise<GaslessCommandRecord | null>;
  getQueueStats(now: string): Promise<GaslessCommandQueueStats>;
}
