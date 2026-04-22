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
type ExchangeTrustedSessionRequest = Parameters<AuthController['exchangeTrustedSession']>[0];
type LoginRequest = Parameters<AuthController['login']>[0];
type ChallengeRequest = Parameters<AuthController['getChallenge']>[0];

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

function makeChallengeRequest(query: ChallengeRequest['query']): ChallengeRequest {
  return { query } as ChallengeRequest;
}

function makeLoginRequest(body: LoginRequest['body']): LoginRequest {
  return { body } as LoginRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AuthController.exchangeTrustedSession', () => {
  test('returns 201 when trusted identity payload is valid', async () => {
    const svc = mockSessionService();
    const ctrl = new AuthController(svc, mockChallengeStore());
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
    const ctrl = new AuthController(svc, mockChallengeStore());
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
    const ctrl = new AuthController(svc, mockChallengeStore());
    const req = makeExchangeRequest({ role: 'admin' });
    const res = mockRes();

    await ctrl.exchangeTrustedSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.issueTrustedSession).not.toHaveBeenCalled();
  });

  test('returns 400 when email is invalid', async () => {
    const svc = mockSessionService();
    const ctrl = new AuthController(svc, mockChallengeStore());
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

// GET /challenge

describe('AuthController.getChallenge', () => {
  test('returns message and stores nonce for valid wallet', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = makeChallengeRequest({ wallet: WALLET });
    const res = mockRes();

    await ctrl.getChallenge(req, res);

    expect(cs.set).toHaveBeenCalledWith(WALLET, expect.any(String), 300);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ message: expect.stringContaining(WALLET) }),
      }),
    );
  });

  test('returns 400 for missing wallet param', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = makeChallengeRequest({});
    const res = mockRes();

    await ctrl.getChallenge(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cs.set).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid wallet format', async () => {
    const cs = mockChallengeStore();
    const ctrl = new AuthController(mockSessionService(), cs);
    const req = makeChallengeRequest({ wallet: 'not-a-wallet' });
    const res = mockRes();

    await ctrl.getChallenge(req, res);

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
    const req = makeLoginRequest({ walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { sessionId: 'sess-1', expiresAt: expect.any(Number) },
      }),
    );
    expect(cs.delete).toHaveBeenCalledWith(WALLET); // nonce consumed
    expect(svc.login).toHaveBeenCalledWith(WALLET, 'buyer', undefined, undefined);
  });

  test('returns 401 when signature does not match wallet', async () => {
    mockVerifyMessage.mockReturnValue('0xsomeoneelse000000000000000000000000000000');
    const svc = mockSessionService();
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({ walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(svc.login).not.toHaveBeenCalled();
    expect(cs.delete).not.toHaveBeenCalled(); // nonce NOT consumed on failure
  });

  test('returns 401 when no challenge exists for wallet', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore(null); // no nonce issued
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({ walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockVerifyMessage).not.toHaveBeenCalled();
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when walletAddress is missing', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({ signature: VALID_SIG, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when signature is missing', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({ walletAddress: WALLET, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 400 when role is invalid', async () => {
    const svc = mockSessionService();
    const cs = mockChallengeStore();
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({
      walletAddress: WALLET,
      signature: VALID_SIG,
      role: 'superuser' as never,
    });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.login).not.toHaveBeenCalled();
  });

  test('returns 403 when service throws (deactivated profile)', async () => {
    mockVerifyMessage.mockReturnValue(WALLET);
    const svc = mockSessionService();
    svc.login.mockRejectedValue(new Error('User profile is deactivated'));
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs);
    const req = makeLoginRequest({ walletAddress: WALLET, signature: VALID_SIG, role: 'buyer' });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('caps ttlSeconds to maxSessionTtlSeconds', async () => {
    mockVerifyMessage.mockReturnValue(WALLET);
    const svc = mockSessionService();
    const cs = mockChallengeStore('test-nonce');
    // max configured to 3600; client requests 999999
    const ctrl = new AuthController(svc, cs, 3600);
    const req = makeLoginRequest({
      walletAddress: WALLET,
      signature: VALID_SIG,
      role: 'buyer',
      ttlSeconds: 999999,
    });
    const res = mockRes();

    await ctrl.login(req, res);

    // sessionService.login must be called with ttl capped at 3600, not 999999
    expect(svc.login).toHaveBeenCalledWith(WALLET, 'buyer', undefined, 3600);
  });

  test('enforces minimum ttlSeconds of 1', async () => {
    mockVerifyMessage.mockReturnValue(WALLET);
    const svc = mockSessionService();
    const cs = mockChallengeStore('test-nonce');
    const ctrl = new AuthController(svc, cs, 3600);
    const req = makeLoginRequest({
      walletAddress: WALLET,
      signature: VALID_SIG,
      role: 'buyer',
      ttlSeconds: 0,
    });
    const res = mockRes();

    await ctrl.login(req, res);

    expect(svc.login).toHaveBeenCalledWith(WALLET, 'buyer', undefined, 1);
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

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          accountId: 'acct-1',
          userId: 'uid-1',
          walletAddress: WALLET,
          email: 'admin@example.com',
          role: 'buyer',
        }),
      }),
    );
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

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { revoked: true },
      }),
    );
    expect(svc.revoke).toHaveBeenCalledWith('sess-1');
  });
});
