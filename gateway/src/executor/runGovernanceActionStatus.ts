/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GovernanceActionStatus } from '../core/governanceStore';

const NON_ZERO_EXIT_STATUSES = new Set<GovernanceActionStatus>([
  'failed',
  'submitted',
  'stale',
]);

export function shouldExitNonZeroForGovernanceAction(status: GovernanceActionStatus): boolean {
  return NON_ZERO_EXIT_STATUSES.has(status);
}
