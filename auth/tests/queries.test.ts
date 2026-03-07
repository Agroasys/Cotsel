/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { normalizeSessionRow } from '../src/database/queries';

describe('normalizeSessionRow', () => {
  test('converts bigint-backed timestamp strings to numbers', () => {
    const session = normalizeSessionRow({
      sessionId: 'sess-1',
      userId: 'user-1',
      walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      role: 'admin',
      issuedAt: '1772916944',
      expiresAt: '1772920544',
      revokedAt: null,
    });

    expect(session.issuedAt).toBe(1772916944);
    expect(session.expiresAt).toBe(1772920544);
    expect(session.revokedAt).toBeNull();
  });

  test('throws on invalid timestamp payloads', () => {
    expect(() =>
      normalizeSessionRow({
        sessionId: 'sess-2',
        userId: 'user-2',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        role: 'admin',
        issuedAt: 'not-a-number',
        expiresAt: '1772920544',
        revokedAt: null,
      }),
    ).toThrow('Invalid issuedAt session timestamp returned from database');
  });
});
