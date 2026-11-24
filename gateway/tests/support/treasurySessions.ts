/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session fixtures for the treasury route contract tests. Admin sessions hold
 * every treasury capability, approved signer bindings for approve, execute and
 * close, and a fresh hardware WebAuthn step-up (Cotsel#946).
 */
import type { AuthSession, AuthSessionClient } from '../../src/core/authSessionClient';
import { freshStepUp } from './stepUp';

const TREASURY_CAPABILITIES = [
  'treasury:read',
  'treasury:prepare',
  'treasury:approve',
  'treasury:execute_match',
  'treasury:close',
];

const binding = (actionClass: string, suffix: string, ticketRef: string) => ({
  bindingId: `binding-treasury-${suffix}`,
  walletAddress: '0x00000000000000000000000000000000000000aa',
  actionClass,
  environment: 'test',
  approvedAt: '2026-03-14T00:00:00.000Z',
  approvedBy: 'ops-admin-control',
  ticketRef,
  notes: null,
});

export function createTreasurySessionClient(
  role: 'admin' | 'buyer' | null,
  overrides: Partial<AuthSession> = {},
): AuthSessionClient {
  return {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (role === null) {
        return null;
      }
      return {
        accountId: `acct-${role}`,
        userId: `uid-${role}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role,
        capabilities: role === 'admin' ? TREASURY_CAPABILITIES : [],
        signerAuthorizations:
          role === 'admin'
            ? [
                binding('treasury_approve', 'approve', 'FIN-900'),
                binding('treasury_execute', 'execute', 'FIN-901'),
                binding('treasury_close', 'close', 'FIN-902'),
              ]
            : [],
        authentication: freshStepUp(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        ...overrides,
      };
    }),
    checkReadiness: jest.fn(),
  };
}
