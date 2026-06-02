/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BreakGlassReviewStatus } from '../types';

export interface BreakGlassReviewStatusInput {
  active: boolean;
  role: 'admin' | null;
  expiresAt: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  reviewedAt: string | null;
}

export function resolveBreakGlassReviewStatus(
  input: BreakGlassReviewStatusInput,
): BreakGlassReviewStatus {
  if (input.reviewedAt) {
    return 'reviewed';
  }
  if (!input.role && !input.grantedAt && !input.expiresAt && !input.revokedAt) {
    return 'none';
  }
  if (input.revokedAt) {
    return 'revoked_unreviewed';
  }
  if (input.active) {
    return 'active_unreviewed';
  }
  return 'expired_unreviewed';
}
