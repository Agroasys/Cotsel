/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * One place that turns a thrown error into a response. It lives beside the
 * controller rather than inside it because the mapping is a policy -- which
 * refusals are the caller's fault, and which are about state the caller cannot
 * see -- and every route has to apply the same one.
 */
import { failure, HttpError } from '@agroasys/shared-http';
import { ProviderHandoffAuthorityError } from '../core/providerHandoffAuthority';
import { SweepCanonicalityError } from '../core/sweepCanonicality';
import { PartnerHandoffConflictError } from '../core/treasuryPartnerHandoff';

export function mapValidationError(error: unknown, fallbackMessage: string) {
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

  if (error instanceof ProviderHandoffAuthorityError) {
    return { statusCode: 400, body: failure(error.code, error.message) };
  }

  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      body: failure(error.code, error.message, error.details),
    };
  }

  if (error instanceof Error) {
    return {
      statusCode: 400,
      body: failure('ValidationError', error.message || fallbackMessage),
    };
  }

  return {
    statusCode: 400,
    body: failure('ValidationError', fallbackMessage),
  };
}
