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
  if (!input.role && !input.grantedAt && !input.expiresAt && !input.revokedAt) {
    return 'none';
  }
  const grantIsCurrentlyActive =
    input.role === 'admin' &&
    input.expiresAt !== null &&
    Date.parse(input.expiresAt) > Date.now() &&
    input.revokedAt === null;
  const hasClosureEvidence =
    input.revokedAt !== null ||
    (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now());

  if (input.active || grantIsCurrentlyActive) {
    return 'active_unreviewed';
  }
  if (input.reviewedAt && hasClosureEvidence) {
    return 'reviewed';
  }
  if (input.revokedAt) {
    return 'revoked_unreviewed';
  }
  return 'expired_unreviewed';
}
