/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from 'express';
import { config } from '../config';
import {
  resolveAuthenticatedActor,
  resolveOptionalAuthenticatedActor,
  type AuthenticatedRequest,
} from '../core/actorIdentity';

/**
 * Single entry point for every treasury mutation that attributes a financial
 * transition to someone. Handlers pass whatever the body claimed; what comes
 * back is the authenticated principal.
 */
export function actorFor(req: Request, claimed: string | undefined, field = 'actor'): string {
  return resolveAuthenticatedActor(req as AuthenticatedRequest, claimed, {
    authEnabled: config.authEnabled,
    delegationApiKeyIds: config.operatorDelegationApiKeys,
    field,
  });
}

export function optionalActorFor(
  req: Request,
  claimed: string | undefined,
  field = 'actor',
): string | undefined {
  return resolveOptionalAuthenticatedActor(req as AuthenticatedRequest, claimed, {
    authEnabled: config.authEnabled,
    delegationApiKeyIds: config.operatorDelegationApiKeys,
    field,
  });
}
