/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createSessionService } from '../src/core/sessionService';
import { ProfileStore } from '../src/core/profileStore';
import { SessionStore } from '../src/core/sessionStore';
import { UserProfile, UserSession, SessionIssueResult } from '../src/types';

//  Helpers 

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'uuid-1',
    accountId: 'acct-1',
    walletAddress: '0xdeadbeef',
    email: 'admin@example.com',
    role: 'buyer',
    orgId: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeActiveSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    sessionId: 'session-abc',
    accountId: 'acct-1',
    userId: 'uuid-1',
    walletAddress: '0xdeadbeef',
    email: 'admin@example.com',
    role: 'buyer',
    issuedAt: nowSeconds(),
    expiresAt: nowSeconds() + 3600,
    revokedAt: null,
    ...overrides,
  };
}

function makeStores(profile: UserProfile) {
  let sessionDb: Record<string, UserSession> = {};

  const sessionStore = {
    issue: jest.fn(async (p: UserProfile, ttl: number): Promise<SessionIssueResult> => {
      const id = 'session-abc';
      const now = nowSeconds();
      const s: UserSession = {
        sessionId: id,
        accountId: p.accountId,
        userId: p.id,
        walletAddress: p.walletAddress,
        email: p.email,
        role: p.role,
        issuedAt: now,
        expiresAt: now + ttl,
        revokedAt: null,
      };
      sessionDb[id] = s;
      return { sessionId: id, expiresAt: s.expiresAt };
    }),
    lookup: jest.fn(async (_id: string): Promise<UserSession | null> => sessionDb[_id] ?? null),
    revoke: jest.fn(async (id: string): Promise<void> => {
      if (sessionDb[id]) sessionDb[id].revokedAt = nowSeconds();
    }),
    pruneExpired: jest.fn(async (): Promise<void> => undefined),
  } satisfies SessionStore;

  const profileStore = {
    upsert: jest.fn(async (_w: string, _r: UserProfile['role'], _o?: string): Promise<UserProfile> => profile),
    upsertTrustedIdentity: jest.fn(async (identity) => ({
      ...profile,
      accountId: identity.accountId,
      role: identity.role,
      walletAddress: identity.walletAddress ?? null,
      email: identity.email ?? null,
      orgId: identity.orgId ?? null,
    })),
    findByWallet: jest.fn(async (_w: string): Promise<UserProfile | null> => profile),
    findByAccountId: jest.fn(async (_accountId: string): Promise<UserProfile | null> => profile),
    findById: jest.fn(async (_id: string): Promise<UserProfile | null> => profile),
    deactivate: jest.fn(async (_id: string): Promise<void> => undefined),
  } satisfies ProfileStore;

  return { sessionStore, profileStore, sessionDb };
}

//  Tests

describe('sessionService.login', () => {
  test('upserts profile and issues session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    const result = await svc.login('0xDeadBeef', 'buyer');

    expect(result.sessionId).toBe('session-abc');
    expect(profileStore.upsert).toHaveBeenCalledWith('0xdeadbeef', 'buyer', undefined);
    expect(sessionStore.issue).toHaveBeenCalledTimes(1);
  });

  test('normalises walletAddress to lowercase', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    await svc.login('0xABCDEF', 'supplier');
    expect(profileStore.upsert).toHaveBeenCalledWith('0xabcdef', 'supplier', undefined);
  });

  test('throws when profile is deactivated', async () => {
    const profile = makeProfile({ active: false });
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    await expect(svc.login('0xdeadbeef', 'buyer')).rejects.toThrow('deactivated');
    expect(sessionStore.issue).not.toHaveBeenCalled();
  });

  test('respects custom ttlSeconds', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    await svc.login('0xdeadbeef', 'buyer', undefined, 7200);
    expect(sessionStore.issue).toHaveBeenCalledWith(profile, 7200);
  });
});

describe('sessionService.resolve', () => {
  test('returns active session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    const svc = createSessionService(sessionStore, profileStore);

    const s = await svc.resolve('session-abc');
    expect(s).not.toBeNull();
    expect(s?.sessionId).toBe('session-abc');
  });

  test('returns null for unknown sessionId', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(null);
    const svc = createSessionService(sessionStore, profileStore);

    expect(await svc.resolve('nope')).toBeNull();
  });

  test('returns null for expired session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ expiresAt: nowSeconds() - 1 }));
    const svc = createSessionService(sessionStore, profileStore);

    expect(await svc.resolve('session-abc')).toBeNull();
  });

  test('returns null for revoked session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ revokedAt: nowSeconds() - 10 }));
    const svc = createSessionService(sessionStore, profileStore);

    expect(await svc.resolve('session-abc')).toBeNull();
  });
});

describe('sessionService.issueTrustedSession', () => {
  test('upserts trusted identity and issues a wallet-optional session', async () => {
    const profile = makeProfile({ walletAddress: null, email: 'ops@example.com' });
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    const result = await svc.issueTrustedSession({
      accountId: 'agroasys-user:42',
      role: 'admin',
      email: 'ops@example.com',
      walletAddress: null,
    });

    expect(result.sessionId).toBe('session-abc');
    expect(profileStore.upsertTrustedIdentity).toHaveBeenCalledWith({
      accountId: 'agroasys-user:42',
      role: 'admin',
      email: 'ops@example.com',
      walletAddress: null,
    });
    expect(sessionStore.issue).toHaveBeenCalledTimes(1);
  });
});

describe('sessionService.refresh', () => {
  test('revokes old session and issues a new one', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    const svc = createSessionService(sessionStore, profileStore);

    const result = await svc.refresh('session-abc');
    expect(result.sessionId).toBeDefined();
    expect(sessionStore.revoke).toHaveBeenCalledWith('session-abc');
    expect(sessionStore.issue).toHaveBeenCalledTimes(1);
  });

  test('throws for expired session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ expiresAt: nowSeconds() - 1 }));
    const svc = createSessionService(sessionStore, profileStore);

    await expect(svc.refresh('session-abc')).rejects.toThrow('invalid, expired, or revoked');
  });

  test('throws when profile is inactive', async () => {
    const profile = makeProfile({ active: false });
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    profileStore.findById.mockResolvedValue(profile);
    const svc = createSessionService(sessionStore, profileStore);

    await expect(svc.refresh('session-abc')).rejects.toThrow('inactive');
  });

  test('throws for revoked session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ revokedAt: nowSeconds() - 5 }));
    const svc = createSessionService(sessionStore, profileStore);

    await expect(svc.refresh('session-abc')).rejects.toThrow('invalid, expired, or revoked');
  });
});

describe('sessionService.revoke', () => {
  test('delegates to session store', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore);

    await svc.revoke('session-abc');
    expect(sessionStore.revoke).toHaveBeenCalledWith('session-abc');
  });
});
