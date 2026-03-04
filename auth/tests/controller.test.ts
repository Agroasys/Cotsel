/**
 * SPDX-License-Identifier: Apache-2.0
 * Unit tests for AuthController.
 */
import { Request, Response } from 'express';
import { AuthController } from '../src/api/controller';
import { SessionService } from '../src/core/sessionService';
import { ChallengeStore } from '../src/core/challengeStore';
import { UserSession } from '../src/types';

// Mock ethers so we can control verifyMessage without a real wallet in tests
jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
}));
import { verifyMessage } from 'ethers';
const mockVerifyMessage = verifyMessage as jest.MockedFunction<typeof verifyMessage>;

const WALLET = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const VALID_SIG = '0xsig';

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
    refresh: jest.fn().mockResolvedValue({ sessionId: 'sess-2', expiresAt: nowSeconds() + 3600 }),
    revoke: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as jest.Mocked<SessionService>;
}

function mockChallengeStore(nonce: string | null = 'test-nonce'): jest.Mocked<ChallengeStore> {
  return {
    set: jest.fn(),
    get: jest.fn().mockReturnValue(nonce),
    delete: jest.fn(),
  };
}

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    sessionId: 'sess-1',
    userId: 'uid-1',
    walletAddress: WALLET,
    role: 'buyer',
    issuedAt: nowSeconds(),
    expiresAt: nowSeconds() + 3600,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// GET /challenge

describe('AuthController.getChallenge', () => {
  test('returns message and stores nonce for valid wallet', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = { query: { wallet: WALLET } } as unknown as Request;
    const res = mockRes();

    await ctrl.getChallenge(req as any, res);

    expect(cs.set).toHaveBeenCalledWith(WALLET, expect.any(String), 300);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ message: expect.stringContaining(WALLET) }),
    }));
  });

  test('returns 400 for missing wallet param', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = { query: {} } as unknown as Request;
    const res = mockRes();

    await ctrl.getChallenge(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cs.set).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid wallet format', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = { query: { wallet: 'not-a-wallet' } } as unknown as Request;
    const res = mockRes();

    await ctrl.getChallenge(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// POST /login

describe('AuthController.login', () => {
  test('returns 201 when signature is valid', async () => {
    // verifyMessage returns the wallet address → proof of ownership
    mockVerifyMessage.mockReturnValue(WALLET);
    const svc = mockSessionService();
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { sessionId: 'sess-1', expiresAt: expect.any(Number) },
    }));
    expect(cs.delete).toHaveBeenCalledWith(WALLET); // nonce consumed
    expect(svc.login).toHaveBeenCalledWith(WALLET, 'buyer', undefined, undefined);
  });

  test('returns 401 when signature does not match wallet', async () => {
    mockVerifyMessage.mockReturnValue('0xsomeoneelse000000000000000000000000000000');
    const svc = mockSessionService();
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(svc.login).not.toHaveBeenCalled();
    expect(cs.delete).not.toHaveBeenCalled(); // nonce NOT consumed on failure
  });

  test('returns 401 when no challenge exists for wallet', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore(null); // no nonce issued
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockVerifyMessage).not.toHaveBeenCalled();
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when walletAddress is missing', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = { body: { signature: VALID_SIG, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when signature is missing', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when role is invalid', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, signature: VALID_SIG, role: 'superuser' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 403 when service throws (deactivated profile)', async () => {
    mockVerifyMessage.mockReturnValue(WALLET);
    const svc = mockSessionService();
    svc.login.mockRejectedValue(new Error('User profile is deactivated'));
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs);
    const req = { body: { walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' } } as Request;
    const res = mockRes();

    await ctrl.login(req as any, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// GET /session

describe('AuthController.getSession', () => {
  test('returns session fields', () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const session = makeSession();
    const req = { userSession: session } as Request;
    const res = mockRes();

    ctrl.getSession(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        userId: 'uid-1',
        walletAddress: WALLET,
        role: 'buyer',
      }),
    }));
  });
});

// POST /session/refresh

describe('AuthController.refresh', () => {
  test('returns new sessionId on success', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = { userSession: makeSession() } as Request;
    const res = mockRes();

    await ctrl.refresh(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { sessionId: 'sess-2', expiresAt: expect.any(Number) },
    }));
  });

  test('returns 401 when service throws', async () => {
    const svc = mockSessionService();
    svc.refresh.mockRejectedValue(new Error('Session invalid'));
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = { userSession: makeSession() } as Request;
    const res = mockRes();

    await ctrl.refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// POST /session/revoke

describe('AuthController.revoke', () => {
  test('returns revoked:true', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = { userSession: makeSession() } as Request;
    const res = mockRes();

    await ctrl.revoke(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { revoked: true },
    }));
    expect(svc.revoke).toHaveBeenCalledWith('sess-1');
  });
});
