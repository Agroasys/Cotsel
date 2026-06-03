/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolveBreakGlassReviewStatus } from '../src/core/breakGlassReviewStatus';

const ACTIVE_GRANT_EXPIRES_AT = new Date(Date.now() + 86_400_000).toISOString();
const ACTIVE_GRANT_GRANTED_AT = new Date(Date.now() - 86_400_000).toISOString();

describe('resolveBreakGlassReviewStatus', () => {
  test.each([
    [
      'none',
      {
        active: false,
        role: null,
        expiresAt: null,
        grantedAt: null,
        revokedAt: null,
        reviewedAt: null,
      },
    ],
    [
      'active_unreviewed',
      {
        active: true,
        role: 'admin' as const,
        expiresAt: ACTIVE_GRANT_EXPIRES_AT,
        grantedAt: ACTIVE_GRANT_GRANTED_AT,
        revokedAt: null,
        reviewedAt: null,
      },
    ],
    [
      'revoked_unreviewed',
      {
        active: false,
        role: 'admin' as const,
        expiresAt: '2026-06-02T00:00:00.000Z',
        grantedAt: '2026-06-01T00:00:00.000Z',
        revokedAt: '2026-06-01T01:00:00.000Z',
        reviewedAt: null,
      },
    ],
    [
      'expired_unreviewed',
      {
        active: false,
        role: 'admin' as const,
        expiresAt: '2026-06-01T00:00:00.000Z',
        grantedAt: '2026-06-01T00:00:00.000Z',
        revokedAt: null,
        reviewedAt: null,
      },
    ],
    [
      'reviewed',
      {
        active: false,
        role: 'admin' as const,
        expiresAt: '2026-06-01T00:00:00.000Z',
        grantedAt: '2026-06-01T00:00:00.000Z',
        revokedAt: null,
        reviewedAt: '2026-06-01T02:00:00.000Z',
      },
    ],
    [
      'active_unreviewed',
      {
        active: true,
        role: 'admin' as const,
        expiresAt: ACTIVE_GRANT_EXPIRES_AT,
        grantedAt: ACTIVE_GRANT_GRANTED_AT,
        revokedAt: null,
        reviewedAt: '2026-06-01T02:00:00.000Z',
      },
    ],
    [
      'expired_unreviewed',
      {
        active: false,
        role: 'admin' as const,
        expiresAt: null,
        grantedAt: '2026-06-01T00:00:00.000Z',
        revokedAt: null,
        reviewedAt: '2026-06-01T02:00:00.000Z',
      },
    ],
  ] as const)('returns %s', (expected, input) => {
    expect(resolveBreakGlassReviewStatus(input)).toBe(expected);
  });
});
