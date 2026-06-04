/**
 * SPDX-License-Identifier: Apache-2.0
 * Unit tests for SessionController.
 */
import { Request, Response } from 'express';
import { SessionController } from '../src/api/controller';
import { SessionService } from '../src/core/sessionService';
import { UserSession } from '../src/types';

const WALLET = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
type ExchangeTrustedSessionRequest = Parameters<SessionController['exchangeTrustedSession']>[0];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockSessionService(overrides: Partial<SessionService> = {}): jest.Mocked<SessionService> {
  return {
    login: jest.fn().mockResolvedValue({ sessionId: 'sess-1', expiresAt: nowSeconds() + 3600 }),
    issueTrustedSession: jest
      .fn()
      .mockResolvedValue({ sessionId: 'sess-trusted', expiresAt: nowSeconds() + 3600 }),
    refresh: jest.fn().mockResolvedValue({ sessionId: 'sess-2', expiresAt: nowSeconds() + 3600 }),
    revoke: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as jest.Mocked<SessionService>;
}

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    userId: 'uid-1',
    walletAddress: WALLET,
    email: 'admin@example.com',
    role: 'buyer',
    capabilities: [],
    signerAuthorizations: [],
    issuedAt: nowSeconds(),
    expiresAt: nowSeconds() + 3600,
    revokedAt: null,
    ...overrides,
  };
}

function makeExchangeRequest(
  body: ExchangeTrustedSessionRequest['body'],
): ExchangeTrustedSessionRequest {
  return { body } as ExchangeTrustedSessionRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SessionController.exchangeTrustedSession', () => {
  test('returns 201 when trusted identity payload is valid', async () => {
    const svc = mockSessionService();
    const ctrl = new SessionController(svc);
    const req = makeExchangeRequest({
      accountId: 'agroasys-user:42',
      role: 'admin',
      email: 'Ops.Admin@Example.com',
      walletAddress: WALLET,
    });
    const res = mockRes();

    await ctrl.exchangeTrustedSession(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(svc.issueTrustedSession).toHaveBeenCalledWith(
      {
        accountId: 'agroasys-user:42',
        role: 'admin',
        orgId: null,
        email: 'ops.admin@example.com',
        walletAddress: WALLET,
      },
      undefined,
    );
  });

  test('allows trusted exchange without wallet address', async () => {
    const svc = mockSessionService();
    const ctrl = new SessionController(svc);
    const req = makeExchangeRequest({
      accountId: 'agroasys-user:42',
      role: 'admin',
      email: 'ops@example.com',
    });
    const res = mockRes();

    await ctrl.exchangeTrustedSession(req, res);

    expect(svc.issueTrustedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'agroasys-user:42',
        walletAddress: null,
      }),
      undefined,
    );
  });

  test('returns 400 when accountId is missing', async () => {
    const svc = mockSessionService();
    const ctrl = new SessionController(svc);
    const req = makeExchangeRequest({ role: 'admin' });
    const res = mockRes();

    await ctrl.exchangeTrustedSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.issueTrustedSession).not.toHaveBeenCalled();
  });

  test('returns 400 when email is invalid', async () => {
    const svc = mockSessionService();
    const ctrl = new SessionController(svc);
    const req = makeExchangeRequest({
      accountId: 'acct-1',
      role: 'admin',
      email: 'not-an-email',
    });
    const res = mockRes();

    await ctrl.exchangeTrustedSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.issueTrustedSession).not.toHaveBeenCalled();
  });
});

// GET /session

describe('SessionController.getSession', () => {
  test('returns session fields', () => {
    const ctrl = new SessionController(mockSessionService());
    const session = makeSession();
    const req = { userSession: session } as unknown as Request;
    const res = mockRes();

    ctrl.getSession(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          accountId: 'acct-1',
          userId: 'uid-1',
          walletAddress: WALLET,
          email: 'admin@example.com',
          role: 'buyer',
          breakGlass: expect.objectContaining({
            active: false,
            reviewStatus: 'none',
          }),
        }),
      }),
    );
  });
});

// POST /session/refresh

describe('SessionController.refresh', () => {
  test('returns new sessionId on success', async () => {
    const ctrl = new SessionController(mockSessionService());
    const req = { userSession: makeSession() } as unknown as Request;
    const res = mockRes();

    await ctrl.refresh(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { sessionId: 'sess-2', expiresAt: expect.any(Number) },
      }),
    );
  });

  test('returns 401 when service throws', async () => {
    const svc = mockSessionService();
    svc.refresh.mockRejectedValue(new Error('Session invalid'));
    const ctrl = new SessionController(svc);
    const req = { userSession: makeSession() } as unknown as Request;
    const res = mockRes();

    await ctrl.refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// POST /session/revoke

describe('SessionController.revoke', () => {
  test('returns revoked:true', async () => {
    const svc = mockSessionService();
    const ctrl = new SessionController(svc);
    const req = { userSession: makeSession() } as unknown as Request;
    const res = mockRes();

    await ctrl.revoke(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { revoked: true },
      }),
    );
    expect(svc.revoke).toHaveBeenCalledWith('sess-1');
  });
});
