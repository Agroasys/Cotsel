/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AgroasysSDKError } from '../types/errors';
import type {
  AnyExecutionAdapter,
  ExecutionCapability,
  ExecutionObservation,
  ExecutionOutcome,
  ExecutionPayloads,
  ExecutionPreflightResult,
} from './adapters';
import type { CustodyMode } from './custody';
import type { ExecutionConfigProblem, ExecutionCustodyDeclaration } from './config';
import type { ExecutionIdempotencyStore } from './idempotency';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

export class ExecutionConfigError extends AgroasysSDKError {
  constructor(public readonly problems: ExecutionConfigProblem[]) {
    super('Execution routing is not ready: configuration is invalid', 'EXECUTION_CONFIG_INVALID', {
      problems,
    });
    this.name = 'ExecutionConfigError';
  }
}

export type ExecutionRoutingRejection =
  | 'capability_unknown'
  | 'capability_not_configured'
  | 'idempotency_key_invalid'
  | 'payload_invalid'
  | 'no_submission_record'
  | 'submitting_adapter_unavailable'
  | 'custody_mode_changed';

export class ExecutionRoutingError extends AgroasysSDKError {
  constructor(
    public readonly rejection: ExecutionRoutingRejection,
    detail: Record<string, unknown> = {},
  ) {
    super(`Execution request rejected: ${rejection}`, 'EXECUTION_ROUTING_REJECTED', {
      rejection,
      ...detail,
    });
    this.name = 'ExecutionRoutingError';
  }
}

export class ExecutionIdempotencyConflictError extends AgroasysSDKError {
  constructor(key: string) {
    super(
      'Idempotency key was already used for a different request',
      'EXECUTION_IDEMPOTENCY_CONFLICT',
      { key },
    );
    this.name = 'ExecutionIdempotencyConflictError';
  }
}

export interface ExecutionAlert {
  code:
    | 'custody_firewall_rejected'
    | 'observation_mismatch'
    | 'outcome_unknown'
    | 'idempotency_conflict';
  capability: string;
  adapterId?: string;
  idempotencyKey?: string;
  settlementId?: string | null;
  /** A reason code. Never payloads, signatures or provider credentials. */
  detail: string;
}

export interface RoutedExecutionRequest<C extends ExecutionCapability> {
  idempotencyKey: string;
  settlementId: string | null;
  /** The custody mode recorded on the settlement when it was created. */
  settlementCustodyMode: CustodyMode;
  payload: ExecutionPayloads[C];
}

export interface RoutedExecutionStatusQuery {
  idempotencyKey: string;
  settlementCustodyMode: CustodyMode;
}

export interface RoutedExecutionResult {
  outcome: ExecutionOutcome | 'not_found';
  operationRef: string | null;
  reason?: string;
  observation?: ExecutionObservation;
  capability: ExecutionCapability;
  adapterId: string;
  custodyMode: CustodyMode;
  configHash: string;
  idempotencyKey: string;
  settlementId: string | null;
  /** True when an earlier submit's result was returned and the adapter was not called. */
  replayed: boolean;
}

export interface ExecutionReadiness {
  ready: boolean;
  custodyMode: CustodyMode | null;
  configHash: string | null;
  problems: ExecutionConfigProblem[];
}

export interface ExecutionRouter {
  readiness(): ExecutionReadiness;
  declaration(): ExecutionCustodyDeclaration;
  preflight<C extends ExecutionCapability>(
    capability: C,
    request: RoutedExecutionRequest<C>,
  ): Promise<ExecutionPreflightResult>;
  submit<C extends ExecutionCapability>(
    capability: C,
    request: RoutedExecutionRequest<C>,
  ): Promise<RoutedExecutionResult>;
  status(
    capability: ExecutionCapability,
    query: RoutedExecutionStatusQuery,
  ): Promise<RoutedExecutionResult>;
}

export interface CreateExecutionRouterOptions {
  /** Unvalidated deployment configuration; see `validateExecutionConfig`. */
  config: unknown;
  adapters: readonly AnyExecutionAdapter[];
  requiredCapabilities?: readonly ExecutionCapability[];
  idempotencyStore?: ExecutionIdempotencyStore;
  timeoutMs?: number;
  onAlert?: (alert: ExecutionAlert) => void;
}
