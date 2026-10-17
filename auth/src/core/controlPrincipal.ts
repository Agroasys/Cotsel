/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { CallerSafeError } from '@agroasys/shared-http';
import { AdminActor } from '../types';

const HUMAN_CONTROL_PRINCIPAL_REGEX = /^[a-z0-9][a-z0-9:._@/-]{0,127}$/;

/**
 * The canonical `human:<id>` principal behind an admin-control request. Two-person
 * controls compare these, so a change cannot be both proposed and approved by
 * one human. `subject` names the change in the error, e.g. "Signer binding".
 */
export function canonicalControlPrincipal(actor: AdminActor, subject: string): string {
  const humanPrincipalId = actor.humanPrincipalId?.trim() ?? '';
  if (
    actor.type !== 'service_auth' ||
    actor.id.trim() === '' ||
    !HUMAN_CONTROL_PRINCIPAL_REGEX.test(humanPrincipalId)
  ) {
    throw new CallerSafeError(
      `${subject} changes require an authenticated human control principal`,
    );
  }
  return `human:${humanPrincipalId}`;
}
