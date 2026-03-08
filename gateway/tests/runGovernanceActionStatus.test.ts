/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { shouldExitNonZeroForGovernanceAction } from '../src/executor/runGovernanceActionStatus';

describe('runGovernanceAction exit status mapping', () => {
  test.each(['failed', 'submitted', 'stale'] as const)(
    'returns non-zero for %s outcomes',
    (status) => {
      expect(shouldExitNonZeroForGovernanceAction(status)).toBe(true);
    },
  );

  test.each(['requested', 'pending_approvals', 'approved', 'executed', 'cancelled', 'expired'] as const)(
    'returns zero for %s outcomes',
    (status) => {
      expect(shouldExitNonZeroForGovernanceAction(status)).toBe(false);
    },
  );
});
