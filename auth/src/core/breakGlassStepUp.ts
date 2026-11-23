/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Break-glass always requires a fresh step-up (Cotsel#946).
 *
 * A grant arrives from Agroasys's admin-control client, HMAC-signed over the
 * body, so the operator's assurance in `operatorAuthentication` is attested by
 * the same trusted caller as a session exchange. Cotsel refuses the grant
 * unless that step-up is recent and strong enough, so the guarantee holds at
 * Cotsel's own boundary rather than only behind Agroasys's proxy.
 */
import { HttpError } from '@agroasys/shared-http';
import { parseAuthenticationAssurance } from '../api/sessionController';
import type { AuthenticationAssurance, AuthenticationStrength } from '../types';
import { Logger } from '../utils/logger';

export interface BreakGlassStepUpPolicy {
  maxAgeSeconds: number;
  acceptedStrengths: readonly AuthenticationStrength[];
}

export const DEFAULT_BREAK_GLASS_STEP_UP_POLICY: BreakGlassStepUpPolicy = Object.freeze({
  maxAgeSeconds: 300,
  acceptedStrengths: Object.freeze(['hardware_webauthn'] as AuthenticationStrength[]),
});

function refuse(reason: string): never {
  Logger.warn('Break-glass grant refused without a fresh step-up', {
    eventType: 'auth.break_glass_step_up_required',
    reason,
  });
  throw new HttpError(403, 'StepUpRequired', `Break-glass requires a fresh step-up: ${reason}`);
}

/**
 * Returns the operator's verified assurance, or throws 403 StepUpRequired. A
 * malformed claim is a 400 from the shared parser, never silently ignored.
 */
export function requireFreshBreakGlassStepUp(
  operatorAuthentication: unknown,
  policy: BreakGlassStepUpPolicy,
  nowSeconds: number,
): AuthenticationAssurance {
  if (
    !operatorAuthentication ||
    typeof operatorAuthentication !== 'object' ||
    Array.isArray(operatorAuthentication)
  ) {
    refuse('operatorAuthentication is missing');
  }
  const assurance = parseAuthenticationAssurance(operatorAuthentication, nowSeconds);
  if (assurance.authTime === null) refuse('no authentication time');
  if (!assurance.strength || !policy.acceptedStrengths.includes(assurance.strength)) {
    refuse(`strength ${assurance.strength ?? 'none'} is not accepted`);
  }
  if (nowSeconds - assurance.authTime > policy.maxAgeSeconds) {
    refuse(`step-up is older than ${policy.maxAgeSeconds} seconds`);
  }
  return assurance;
}
