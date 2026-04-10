/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AuthClient, AuthRole, SessionResult } from '../src/modules/authClient';
import { web3Wallet } from '../src/wallet/wallet-provider';

// Mock web3Wallet

const mockConnect = jest.fn<Promise<void>, []>();
const mockGetAddress = jest.fn<Promise<string>, []>();
const mockSignMessage = jest.fn<Promise<string>, [string]>();
const mockGetNetwork = jest.fn<Promise<{ chainId: bigint }>, []>();

jest.mock('../src/wallet/wallet-provider', () => ({
  web3Wallet: {
    connect: () => mockConnect(),
    getSigner: jest.fn(async () => ({
      getAddress: mockGetAddress,
      signMessage: mockSignMessage,
      provider: {
        getNetwork: mockGetNetwork,
      },
    })),
  },
}));

// Mock global fetch

const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
global.fetch = mockFetch as unknown as typeof fetch;

function mockOk(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as unknown as Response;
}

function mockErr(message: string, status = 400): Response {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, message }),
  } as unknown as Response;
}

// ── Fixtures

const BASE = 'https://auth.test.com';
const WALLET = '0xabc123def456abc123def456abc123def456abc1';
const CHALLENGE_MSG = `Sign in to Agroasys\nWallet: ${WALLET}\nNonce: aabbcc112233`;
const SIG = '0xdeadbeef';
const SESSION: SessionResult = {
  sessionId: 'sess-001',
  walletAddress: WALLET,
  role: 'buyer' as AuthRole,
  issuedAt: 1700000000,
  expiresAt: 1700086400,
};

// Tests

describe('AuthClient', () => {
  let client: AuthClient;
  const mockedGetSigner = jest.mocked(web3Wallet.getSigner);

  beforeEach(() => {
    jest.clearAllMocks();
    client = new AuthClient({ baseUrl: BASE });
    mockConnect.mockResolvedValue(undefined);
    mockGetAddress.mockResolvedValue(WALLET);
    mockSignMessage.mockResolvedValue(SIG);
    mockGetNetwork.mockResolvedValue({ chainId: 84532n });
  });

  // login()

  describe('login()', () => {
    test('performs challenge → sign → login and returns session', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockOk(SESSION));

      const result = await client.login({ role: 'buyer' });

      expect(mockConnect).toHaveBeenCalledTimes(1);

      // challenge request targets correct URL with wallet param
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `${BASE}/api/auth/v1/challenge?wallet=${encodeURIComponent(WALLET)}`,
        expect.objectContaining({ method: 'GET' }),
      );

      // browser signs the exact message returned by the challenge
      expect(mockSignMessage).toHaveBeenCalledWith(CHALLENGE_MSG);

      // login request targets correct login endpoint and contains walletAddress + signature + role
      const loginUrl = mockFetch.mock.calls[1]![0] as string;
      expect(loginUrl).toBe(`${BASE}/api/auth/v1/login`);
      const loginInit = mockFetch.mock.calls[1]![1] as RequestInit;
      const loginBody = JSON.parse(loginInit.body as string);
      expect(loginBody.walletAddress).toBe(WALLET);
      expect(loginBody.signature).toBe(SIG);
      expect(loginBody.role).toBe('buyer');

      expect(result).toEqual(SESSION);
    });

    test('rejects when wallet signer cannot be obtained', async () => {
      mockedGetSigner.mockRejectedValueOnce(new Error('wallet not available'));

      await expect(client.login({ role: 'buyer' })).rejects.toThrow('wallet not available');
    });

    test('rejects when wallet address retrieval fails', async () => {
      mockGetAddress.mockRejectedValueOnce(new Error('user rejected connection'));
      await expect(client.login({ role: 'buyer' })).rejects.toThrow('user rejected connection');
    });

    test('normalises wallet address to lowercase before challenge', async () => {
      mockGetAddress.mockResolvedValue('0xABC123DEF456ABC123DEF456ABC123DEF456ABC1');
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockOk(SESSION));

      await client.login({ role: 'buyer' });

      const challengeUrl = mockFetch.mock.calls[0]![0] as string;
      expect(challengeUrl).toContain(WALLET); // lowercase
    });

    test('includes optional orgId and ttlSeconds when provided', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockOk(SESSION));

      await client.login({ role: 'supplier', orgId: 'org-42', ttlSeconds: 3600 });

      const loginBody = JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string);
      expect(loginBody.orgId).toBe('org-42');
      expect(loginBody.ttlSeconds).toBe(3600);
      expect(loginBody.role).toBe('supplier');
    });

    test('does not include orgId or ttlSeconds when omitted', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockOk(SESSION));

      await client.login({ role: 'admin' });

      const loginBody = JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string);
      expect(loginBody).not.toHaveProperty('orgId');
      expect(loginBody).not.toHaveProperty('ttlSeconds');
    });

    test('throws when challenge request fails', async () => {
      mockFetch.mockResolvedValueOnce(mockErr('too many requests', 429));
      await expect(client.login({ role: 'buyer' })).rejects.toThrow('too many requests');
    });

    test('throws when signature is rejected (wrong signer)', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockErr('Unauthorized: signature mismatch', 401));

      await expect(client.login({ role: 'buyer' })).rejects.toThrow('signature mismatch');
    });

    test('throws when challenge nonce has expired', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockErr('No active challenge for this wallet', 401));

      await expect(client.login({ role: 'buyer' })).rejects.toThrow('No active challenge');
    });

    test('rejects when the connected wallet is on the wrong Base network', async () => {
      client = new AuthClient({ baseUrl: BASE, expectedChainId: 84532 });
      mockGetNetwork.mockResolvedValueOnce({ chainId: 8453n });

      await expect(client.login({ role: 'buyer' })).rejects.toThrow(
        'Expected chainId=84532, received 8453',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // refresh()

  describe('refresh()', () => {
    test('posts to session/refresh with Bearer token and returns new session', async () => {
      const newSession = { ...SESSION, sessionId: 'sess-002', issuedAt: 1700010000 };
      mockFetch.mockResolvedValueOnce(mockOk(newSession));

      const result = await client.refresh('tok-old');

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/api/auth/v1/session/refresh`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-old' }),
        }),
      );
      expect(result).toEqual(newSession);
    });

    test('throws when session token is expired', async () => {
      mockFetch.mockResolvedValueOnce(mockErr('Session not found or expired', 401));
      await expect(client.refresh('dead-token')).rejects.toThrow('Session not found');
    });
  });

  // revoke()

  describe('revoke()', () => {
    test('posts to session/revoke with Bearer token', async () => {
      mockFetch.mockResolvedValueOnce(mockOk({}));
      await client.revoke('tok-active');

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/api/auth/v1/session/revoke`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-active' }),
        }),
      );
    });

    test('throws when session is already revoked', async () => {
      mockFetch.mockResolvedValueOnce(mockErr('Session not found or expired', 401));
      await expect(client.revoke('dead-token')).rejects.toThrow('Session not found');
    });
  });

  // getSession()

  describe('getSession()', () => {
    test('fetches session metadata with Bearer token', async () => {
      mockFetch.mockResolvedValueOnce(mockOk(SESSION));

      const result = await client.getSession('tok-123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/api/auth/v1/session`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }),
        }),
      );
      expect(result).toEqual(SESSION);
    });

    test('throws when token is invalid', async () => {
      mockFetch.mockResolvedValueOnce(mockErr('Unauthorized', 401));
      await expect(client.getSession('bad-token')).rejects.toThrow('Unauthorized');
    });
  });

  // URL construction

  describe('baseUrl handling', () => {
    test('strips trailing slash from baseUrl', async () => {
      const c = new AuthClient({ baseUrl: `${BASE}/` });
      mockFetch
        .mockResolvedValueOnce(mockOk({ message: CHALLENGE_MSG, expiresIn: 300 }))
        .mockResolvedValueOnce(mockOk(SESSION));
      await c.login({ role: 'buyer' });

      const challengeUrl = mockFetch.mock.calls[0]![0] as string;
      expect(challengeUrl).not.toContain('//api/auth');
    });
  });
});
