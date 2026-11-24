/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step-up freshness for privileged mutations (Cotsel#946).
 *
 * A Cotsel session lasts up to SESSION_TTL_SECONDS, but the upstream step-up
 * that created it is only fresh for minutes. Privileged governance, treasury and
 * compliance mutations therefore require the session's authentication assurance
 * (auth `GET /session` → `authentication`) to be recent and strong enough.
 * A refused caller re-runs the trusted exchange after a new step-up upstream.
 */
import type { NextFunction, Request, Response } from 'express';
import { runWithStepUpEvidence } from '../core/stepUpAudit';
import { GatewayConfig, resolveStepUpPolicy, StepUpPolicy } from '../config/gatewayConfig';
import type { AuditLogStore } from '../core/auditLogStore';
import type { SessionAuthentication } from '../core/authSessionClient';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';

export type StepUpRefusal = 'no_assurance' | 'stale' | 'insufficient_strength';

export interface StepUpEvaluation {
  fresh: boolean;
  refusal: StepUpRefusal | null;
  ageSeconds: number | null;
}

/** Pure decision, so the boundary cases are tested without HTTP. */
export function evaluateStepUp(
  authentication: SessionAuthentication | undefined,
  policy: StepUpPolicy,
  nowSeconds: number,
): StepUpEvaluation {
  if (!authentication || authentication.authTime === null) {
    return { fresh: false, refusal: 'no_assurance', ageSeconds: null };
  }
  const ageSeconds = Math.max(0, nowSeconds - authentication.authTime);
  if (ageSeconds > policy.maxAgeSeconds) {
    return { fresh: false, refusal: 'stale', ageSeconds };
  }
  if (!authentication.strength || !policy.acceptedStrengths.includes(authentication.strength)) {
    return { fresh: false, refusal: 'insufficient_strength', ageSeconds };
  }
  return { fresh: true, refusal: null, ageSeconds };
}

export interface RequireRecentStepUpOptions {
  /** Records one audit row per privileged request; correlate with the action by requestId. */
  auditLogStore?: AuditLogStore;
  nowSeconds?: () => number;
}

/**
 * Place after authentication and `requireMutationWriteAccess()`. On success the
 * request carries `stepUpEvidence`; in `record` mode a stale step-up is logged
 * and audited but allowed, which is the documented rollback.
 */
export function requireRecentStepUp(
  config: GatewayConfig,
  options: RequireRecentStepUpOptions = {},
) {
  const policy = resolveStepUpPolicy(config);
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const principal = req.gatewayPrincipal;
    if (!principal) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required'));
      return;
    }

    const authentication = principal.session.authentication;
    const evaluation = evaluateStepUp(authentication, policy, now());
    const evidence = {
      authTime: authentication?.authTime ?? null,
      method: authentication?.method ?? null,
      strength: authentication?.strength ?? null,
      ageSeconds: evaluation.ageSeconds,
      maxAgeSeconds: policy.maxAgeSeconds,
      enforcement: policy.enforcement,
    };
    const refusedButRecorded = !evaluation.fresh && policy.enforcement === 'record';
    const eventType = evaluation.fresh
      ? 'gateway.step_up_verified'
      : refusedButRecorded
        ? 'gateway.step_up_stale'
        : 'gateway.step_up_required';

    if (!evaluation.fresh) {
      Logger.warn(
        refusedButRecorded
          ? 'Privileged mutation allowed with a stale step-up (record mode)'
          : 'Privileged mutation refused: step-up required',
        {
          eventType,
          reason: evaluation.refusal,
          route: req.originalUrl,
          method: req.method,
          requestId: req.requestContext?.requestId ?? null,
          userId: principal.session.userId,
        },
      );
    }

    try {
      await options.auditLogStore?.append({
        eventType,
        route: req.originalUrl,
        method: req.method,
        requestId: req.requestContext?.requestId ?? 'unknown',
        correlationId: req.requestContext?.correlationId ?? null,
        actorUserId: principal.session.userId,
        actorWalletAddress: principal.session.walletAddress,
        actorRole: principal.session.role,
        status: evaluation.fresh ? 'accepted' : refusedButRecorded ? 'allowed' : 'rejected',
        metadata: { stepUp: { ...evidence, refusal: evaluation.refusal } },
      });
    } catch (error) {
      // A privileged action that cannot be audited does not proceed.
      Logger.error('Step-up audit record could not be written', { error });
      next(new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Audit store is unavailable'));
      return;
    }

    if (!evaluation.fresh && policy.enforcement === 'enforce') {
      next(
        new GatewayError(403, 'FORBIDDEN', 'A recent step-up authentication is required', {
          reason: 'step_up_required',
          refusal: evaluation.refusal,
          maxAgeSeconds: policy.maxAgeSeconds,
          acceptedStrengths: policy.acceptedStrengths,
          authenticatedAt:
            evidence.authTime === null ? null : new Date(evidence.authTime * 1000).toISOString(),
        }),
      );
      return;
    }

    req.stepUpEvidence = evidence;
    // The action's own audit rows record this evidence (stepUpAudit.ts).
    runWithStepUpEvidence(evidence, () => next());
  };
}
