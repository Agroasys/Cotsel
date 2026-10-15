/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * One place that turns a thrown error into a response. It lives beside the
 * controller rather than inside it because the mapping is a policy -- which
 * refusals are the caller's fault, and which are about state the caller cannot
 * see -- and every route has to apply the same one.
 */
import type { Request, Response } from 'express';
import {
  failure,
  HttpError,
  isCallerFacingError,
  sendInternalFailure,
} from '@agroasys/shared-http';
import { NonCanonicalAmountError } from '../core/canonicalAmount';
import { ProviderHandoffAuthorityError } from '../core/providerHandoffAuthority';
import { SweepCanonicalityError } from '../core/sweepCanonicality';
import { TreasuryConcurrentTransitionError } from '../core/transitionConcurrency';
import { PartnerHandoffConflictError } from '../core/treasuryPartnerHandoff';
import { Logger } from '../utils/logger';

type MappedError = { statusCode: number; body: ReturnType<typeof failure> };

export function mapValidationError(error: unknown, fallbackMessage: string): MappedError | null {
  // WP-4 B-09 / FAIL-11. A frozen or contradicted handoff is a conflict, not a
  // validation failure: the request was well formed and the refusal is about
  // state the caller cannot see, which needs an operator rather than a retry.
  if (error instanceof PartnerHandoffConflictError) {
    return { statusCode: 409, body: failure('PartnerHandoffConflict', error.message) };
  }

  // WP-4 B-08 / PRES-05. The batch is well formed; what it carries is not
  // proven to be on the chain, which is state the caller has to resolve.
  if (error instanceof SweepCanonicalityError) {
    return {
      statusCode: 409,
      body: failure('SweepEligibilityBlocked', error.message, { entryIds: error.entryIds }),
    };
  }

  // H-15. The losing writer of a maker-checker race is a conflict to re-read, not bad input.
  if (error instanceof TreasuryConcurrentTransitionError) {
    return { statusCode: 409, body: failure('ConcurrentTransition', error.message) };
  }

  if (error instanceof NonCanonicalAmountError) {
    return { statusCode: 400, body: failure('ValidationError', error.message) };
  }

  if (error instanceof ProviderHandoffAuthorityError) {
    return { statusCode: 400, body: failure(error.code, error.message) };
  }

  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      body: failure(error.code, error.message, error.details),
    };
  }

  if (isCallerFacingError(error)) {
    return {
      statusCode: 400,
      body: failure('ValidationError', error.message || fallbackMessage),
    };
  }

  return null;
}

/**
 * WP-10 I-06. Known refusals keep their stable code and message; anything else
 * is answered with `InternalError` and a correlation ID, and only logged in full.
 */
export function sendMappedError(
  req: Request,
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void {
  const mapped = mapValidationError(error, fallbackMessage);
  if (mapped) {
    res.status(mapped.statusCode).json(mapped.body);
    return;
  }
  sendTreasuryInternalFailure(req, res, error, fallbackMessage);
}

export function sendTreasuryInternalFailure(
  req: Request,
  res: Response,
  error: unknown,
  operation: string,
  options: { statusCode?: number; code?: string; message?: string } = {},
): void {
  sendInternalFailure(req, res, error, {
    ...options,
    log: (correlationId, cause) =>
      Logger.error('Treasury request failed', {
        operation,
        correlationId,
        errorName: cause instanceof Error ? cause.name : typeof cause,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
