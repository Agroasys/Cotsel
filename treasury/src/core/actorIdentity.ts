/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { HttpError } from '@agroasys/shared-http';
import type { Request } from 'express';

/**
 * Treasury separation of duty is only as strong as the identity it separates.
 * Taking the actor from the request body let any holder of one internal key
 * claim to be the maker on one call and the checker on the next.
 *
 * Identity now always starts from the authenticated principal. Treasury's
 * operator traffic arrives through the dashboard gateway, which authenticates
 * the human and then calls treasury under its own service key, so a body actor
 * is not always a forgery - it can be a delegation the caller is entitled to
 * make. A caller on the delegation allowlist may name the operator it
 * authenticated, and the recorded actor names both. Any other caller must match
 * the principal exactly.
 */

const ACTOR_MAX_LENGTH = 255;
const DELEGATION_SEPARATOR = '::';

export type ServiceAuthScheme = 'api_key' | 'shared_secret';

export interface TreasuryAuthPrincipal {
  apiKeyId: string;
  scheme: ServiceAuthScheme;
  humanPrincipalId?: string;
}

export type AuthenticatedRequest = Request & { serviceAuth?: TreasuryAuthPrincipal };

export interface ActorResolutionOptions {
  /**
   * Mirrors `config.authEnabled`. With auth off there is no principal to derive
   * from, so a local caller must still name itself; production rejects that
   * configuration before the service starts.
   */
  authEnabled: boolean;
  /** API key ids permitted to act for an operator identity they authenticated. */
  delegationApiKeyIds?: string[];
  field?: string;
}

function principalActor(principal: TreasuryAuthPrincipal): string {
  if (principal.humanPrincipalId) {
    return principal.humanPrincipalId;
  }

  return `service:${principal.apiKeyId}`;
}

export function resolveAuthenticatedActor(
  req: AuthenticatedRequest,
  claimedActor: string | undefined,
  options: ActorResolutionOptions,
): string {
  const field = options.field ?? 'actor';
  const claimed = claimedActor?.trim() || undefined;

  if (!options.authEnabled) {
    if (!claimed) {
      throw new HttpError(
        400,
        'ValidationError',
        `${field} is required while service authentication is disabled`,
      );
    }

    return claimed;
  }

  const principal = req.serviceAuth;
  if (!principal?.apiKeyId) {
    throw new HttpError(
      401,
      'ActorUnauthenticated',
      'Treasury transitions require an authenticated principal',
    );
  }

  const authenticatedActor = principalActor(principal);

  if (!claimed || claimed === authenticatedActor) {
    return authenticatedActor;
  }

  if (!(options.delegationApiKeyIds ?? []).includes(principal.apiKeyId)) {
    throw new HttpError(
      403,
      'ActorMismatch',
      `${field} does not match the authenticated principal`,
      {
        authenticatedActor,
      },
    );
  }

  // Both identities are recorded: the service that authenticated, and the
  // operator it authenticated. Neither can be attributed without the other.
  const delegatedActor = `${authenticatedActor}${DELEGATION_SEPARATOR}${claimed}`;

  if (delegatedActor.length > ACTOR_MAX_LENGTH) {
    throw new HttpError(
      400,
      'ValidationError',
      `${field} is too long to record as a delegated treasury actor`,
      { maxLength: ACTOR_MAX_LENGTH },
    );
  }

  return delegatedActor;
}

/**
 * Some lifecycle records carry an actor as annotation rather than as an
 * authorisation. With authentication on they are still bound to the
 * authenticated principal; with it off they may simply be unattributed.
 */
export function resolveOptionalAuthenticatedActor(
  req: AuthenticatedRequest,
  claimedActor: string | undefined,
  options: ActorResolutionOptions,
): string | undefined {
  if (!options.authEnabled) {
    return claimedActor?.trim() || undefined;
  }

  return resolveAuthenticatedActor(req, claimedActor, options);
}
