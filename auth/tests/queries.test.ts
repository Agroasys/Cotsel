/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { normalizeSessionRow } from '../src/database/queries';

describe('normalizeSessionRow', () => {
  test('converts bigint-backed timestamp strings to numbers', () => {
    const session = normalizeSessionRow({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      userId: 'user-1',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      email: 'ops@example.com',
      role: 'admin',
      issuedAt: '1772916944',
      expiresAt: '1772920544',
      revokedAt: null,
    });

    expect(session.accountId).toBe('acct-1');
    expect(session.email).toBe('ops@example.com');
    expect(session.issuedAt).toBe(1772916944);
    expect(session.expiresAt).toBe(1772920544);
    expect(session.revokedAt).toBeNull();
  });

  test('throws on invalid timestamp payloads', () => {
    expect(() =>
      normalizeSessionRow({
        sessionId: 'sess-2',
        accountId: 'acct-2',
        userId: 'user-2',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        email: null,
        role: 'admin',
        issuedAt: 'not-a-number',
        expiresAt: '1772920544',
        revokedAt: null,
      }),
    ).toThrow('Invalid issuedAt session timestamp returned from database');
  });
});
