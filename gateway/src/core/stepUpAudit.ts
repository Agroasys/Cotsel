/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step-up evidence on each privileged action's own audit entry (Cotsel#946).
 *
 * requireRecentStepUp runs the rest of the request inside this scope, and the
 * audit writers merge the scope's evidence into `metadata.stepUp`. So every
 * audit row a guarded action writes, in any store, names the step-up it was
 * authorized with, and a row written outside a guarded request is unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface StepUpEvidence {
  authTime: number | null;
  method: string | null;
  strength: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  enforcement: 'enforce' | 'record';
  /** Distinguishes the current authorizer from a replayed intent's original actor. */
  authorization?: {
    actorId: string;
    actorUserId: string;
    sessionReference: string;
    requestId: string;
    correlationId: string | null;
  };
}

const scope = new AsyncLocalStorage<StepUpEvidence>();

/** Runs `next` (the rest of the request) with the step-up evidence in scope. */
export function runWithStepUpEvidence<T>(evidence: StepUpEvidence, next: () => T): T {
  return scope.run(evidence, next);
}

/** The metadata with `stepUp` added when the write happens inside a guarded request. */
export function withStepUpEvidence<T extends Record<string, unknown> | undefined>(
  metadata: T,
): T | (Record<string, unknown> & { stepUp: StepUpEvidence }) {
  const stepUp = scope.getStore();
  if (!stepUp || (metadata && 'stepUp' in metadata)) return metadata;
  return { ...(metadata ?? {}), stepUp };
}
