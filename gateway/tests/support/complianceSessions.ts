/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session fixtures for the compliance route contract tests. Admin tokens
 * `session-admin` and `session-admin-2` carry a fresh hardware WebAuthn step-up;
 * `session-admin-stale` is an admin whose step-up is an hour old (Cotsel#946).
 */
import type { AuthSessionClient } from '../../src/core/authSessionClient';
import { freshStepUp } from './stepUp';

const ADMIN_TOKENS = new Set(['session-admin', 'session-admin-2', 'session-admin-stale']);

export function createComplianceSessionClient(
  sessionRole: 'admin' | 'buyer' | null | undefined,
): AuthSessionClient {
  return {
    resolveSession: jest.fn().mockImplementation(async (token: string) => {
      if (sessionRole === null) {
        return null;
      }
      const role = sessionRole ?? (ADMIN_TOKENS.has(token) ? 'admin' : 'buyer');
      const sessionToken = token || 'session-admin';
      const second = sessionToken === 'session-admin-2';
      const admin = role === 'admin';
      return {
        accountId: admin ? (second ? 'acct-admin-2' : 'acct-admin') : 'acct-buyer',
        userId: admin ? (second ? 'uid-admin-2' : 'uid-admin') : 'uid-buyer',
        walletAddress: admin
          ? second
            ? '0x00000000000000000000000000000000000000ac'
            : '0x00000000000000000000000000000000000000aa'
          : '0x00000000000000000000000000000000000000bb',
        role,
        email: admin ? (second ? 'admin2@agroasys.io' : 'admin@agroasys.io') : 'buyer@agroasys.io',
        capabilities: admin ? ['compliance:write'] : [],
        signerAuthorizations: [],
        authentication: sessionToken === 'session-admin-stale' ? freshStepUp(3600) : freshStepUp(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };
}
