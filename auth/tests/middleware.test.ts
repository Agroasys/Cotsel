/**
 * SPDX-License-Identifier: Apache-2.0
 * Unit tests for session resolution middleware.
 */
import { Request, Response, NextFunction } from 'express';
import { createSessionMiddleware, requireRole } from '../src/middleware/middleware';
import { UserSession } from '../src/types';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    sessionId: 'sess-1',
    userId: 'uid-1',
    walletAddress: '0xdeadbeef',
    role: 'buyer',
    issuedAt: nowSeconds(),
    expiresAt: nowSeconds() + 3600,
    revokedAt: null,
    ...overrides,
  };
}

// createSessionMiddleware 

describe('createSessionMiddleware', () => {
  test('calls next() and attaches session for valid Bearer token', async () => {
    const session = makeSession();
    const resolve = jest.fn().mockResolvedValue(session);
    const mw = createSessionMiddleware(resolve);

    const req = { headers: { authorization: 'Bearer sess-1' } } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userSession).toBe(session);
  });

  test('returns 401 when Authorization header is missing', async () => {
    const resolve = jest.fn();
    const mw = createSessionMiddleware(resolve);

    const req = { headers: {} } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('returns 401 when token resolves to null (expired/revoked)', async () => {
    const resolve = jest.fn().mockResolvedValue(null);
    const mw = createSessionMiddleware(resolve);

    const req = { headers: { authorization: 'Bearer bad-token' }, ip: '127.0.0.1' } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when Bearer token is empty string', async () => {
    const resolve = jest.fn();
    const mw = createSessionMiddleware(resolve);

    const req = { headers: { authorization: 'Bearer ' } } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// requireRole

describe('requireRole', () => {
  test('calls next() when role matches', () => {
    const guard = requireRole('admin', 'buyer');
    const req = { userSession: makeSession({ role: 'buyer' }) } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    guard(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('returns 403 when role does not match', () => {
    const guard = requireRole('admin');
    const req = { userSession: makeSession({ role: 'buyer' }) } as Request;
    const res = mockRes();
    const next: NextFunction = jest.fn();

    guard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
