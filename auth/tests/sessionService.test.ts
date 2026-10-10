/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createSessionService } from '../src/core/sessionService';
import { ProfileStore } from '../src/core/profileStore';
import { SessionRotationResult, SessionStore } from '../src/core/sessionStore';
import { UserProfile, UserRole, UserSession, SessionIssueResult } from '../src/types';

//  Helpers

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'uuid-1',
    accountId: 'acct-1',
    walletAddress: '0xdeadbeef',
    email: 'admin@example.com',
    role: 'buyer',
    baseRole: 'buyer',
    orgId: null,
    active: true,
    breakGlassRole: null,
    breakGlassExpiresAt: null,
    breakGlassGrantedAt: null,
    breakGlassGrantedBy: null,
    breakGlassReason: null,
    breakGlassRevokedAt: null,
    breakGlassRevokedBy: null,
    breakGlassReviewedAt: null,
    breakGlassReviewedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const LIFETIME = { ttlSeconds: 3600, absoluteLifetimeSeconds: 86400 };

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
    capabilities: [],
    signerAuthorizations: [],
    issuedRole: 'buyer',
    active: true,
    issuedAt: nowSeconds(),
    expiresAt: nowSeconds() + 3600,
    revokedAt: null,
    ...overrides,
  };
}

function makeStores(profile: UserProfile) {
  const sessionDb: Record<string, UserSession> = {};

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
        capabilities: [],
        signerAuthorizations: [],
        issuedRole: p.role,
        active: p.active,
        issuedAt: now,
        expiresAt: now + ttl,
        revokedAt: null,
      };
      sessionDb[id] = s;
      return { sessionId: id, expiresAt: s.expiresAt };
    }),
    rotate: jest.fn(async (): Promise<SessionRotationResult> => ({
      status: 'rotated',
      session: { sessionId: 'session-successor', expiresAt: nowSeconds() + 3600 },
    })),
    lookup: jest.fn(async (_id: string): Promise<UserSession | null> => sessionDb[_id] ?? null),
    revoke: jest.fn(async (id: string): Promise<void> => {
      if (sessionDb[id]) sessionDb[id].revokedAt = nowSeconds();
    }),
    pruneExpired: jest.fn(async (): Promise<void> => undefined),
  } satisfies SessionStore;

  const profileStore = {
    upsert: jest.fn(
      async (_w: string, _r: UserProfile['role'], _o?: string): Promise<UserProfile> => profile,
    ),
    upsertTrustedIdentity: jest.fn(async (identity) => ({
      ...profile,
      accountId: identity.accountId,
      role: identity.role,
      baseRole: identity.role,
      walletAddress: identity.walletAddress ?? null,
      email: identity.email ?? null,
      orgId: identity.orgId ?? null,
    })),
    findByWallet: jest.fn(async (_w: string): Promise<UserProfile | null> => profile),
    findByAccountId: jest.fn(async (_accountId: string): Promise<UserProfile | null> => profile),
    findById: jest.fn(async (_id: string): Promise<UserProfile | null> => profile),
    listAuthorityProfiles: jest.fn(async () => []),
    listAuditEvents: jest.fn(async () => []),
    deactivate: jest.fn(async (_id: string): Promise<void> => undefined),
    provision: jest.fn(async (): Promise<UserProfile> => profile),
    grantBreakGlass: jest.fn(async (): Promise<UserProfile> => profile),
    revokeBreakGlass: jest.fn(async (): Promise<UserProfile | null> => profile),
    expireBreakGlass: jest.fn(async (): Promise<UserProfile | null> => profile),
    reviewBreakGlass: jest.fn(async (): Promise<UserProfile> => profile),
    deactivateWithAudit: jest.fn(async (): Promise<UserProfile> => profile),
  } satisfies ProfileStore;

  return { sessionStore, profileStore, sessionDb };
}

//  Tests

describe('sessionService.login', () => {
  test('upserts profile and issues session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    const result = await svc.login('0xDeadBeef', 'buyer');

    expect(result.sessionId).toBe('session-abc');
    expect(profileStore.upsert).toHaveBeenCalledWith('0xdeadbeef', 'buyer', undefined);
    expect(sessionStore.issue).toHaveBeenCalledTimes(1);
  });

  test('normalises walletAddress to lowercase', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await svc.login('0xABCDEF', 'supplier');
    expect(profileStore.upsert).toHaveBeenCalledWith('0xabcdef', 'supplier', undefined);
  });

  test('throws when profile is deactivated', async () => {
    const profile = makeProfile({ active: false });
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.login('0xdeadbeef', 'buyer')).rejects.toThrow('deactivated');
    expect(sessionStore.issue).not.toHaveBeenCalled();
  });

  test.each(['admin', 'oracle'] as UserRole[])(
    'rejects self-serve login for privileged %s role',
    async (role) => {
      const profile = makeProfile();
      const { sessionStore, profileStore } = makeStores(profile);
      const svc = createSessionService(sessionStore, profileStore, LIFETIME);

      await expect(svc.login('0xdeadbeef', role)).rejects.toThrow(
        'Privileged roles must be provisioned server-side',
      );
      expect(profileStore.upsert).not.toHaveBeenCalled();
      expect(sessionStore.issue).not.toHaveBeenCalled();
    },
  );

  test('respects a custom ttlSeconds within the policy', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await svc.login('0xdeadbeef', 'buyer', undefined, 1800);
    expect(sessionStore.issue).toHaveBeenCalledWith(profile, 1800);
  });

  test('defaults to the policy ttl', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await svc.login('0xdeadbeef', 'buyer');
    expect(sessionStore.issue).toHaveBeenCalledWith(profile, LIFETIME.ttlSeconds);
  });

  test.each([-1, 0, 1.5, 3601, Number.MAX_SAFE_INTEGER + 1])(
    'rejects ttlSeconds %p outside the policy',
    async (ttlSeconds) => {
      const profile = makeProfile();
      const { sessionStore, profileStore } = makeStores(profile);
      const svc = createSessionService(sessionStore, profileStore, LIFETIME);

      await expect(svc.login('0xdeadbeef', 'buyer', undefined, ttlSeconds)).rejects.toThrow(
        'ttlSeconds must be an integer between 1 and 3600',
      );
      expect(sessionStore.issue).not.toHaveBeenCalled();
    },
  );
});

describe('sessionService.resolve', () => {
  test('returns active session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    const s = await svc.resolve('session-abc');
    expect(s).not.toBeNull();
    expect(s?.sessionId).toBe('session-abc');
  });

  test('returns null for unknown sessionId', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(null);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    expect(await svc.resolve('nope')).toBeNull();
  });

  test('returns null for expired session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ expiresAt: nowSeconds() - 1 }));
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    expect(await svc.resolve('session-abc')).toBeNull();
  });

  test('returns null for revoked session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ revokedAt: nowSeconds() - 10 }));
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    expect(await svc.resolve('session-abc')).toBeNull();
  });
});

describe('sessionService.issueTrustedSession', () => {
  test('upserts trusted identity and issues a wallet-optional session', async () => {
    const profile = makeProfile({ walletAddress: null, email: 'ops@example.com' });
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

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

describe('session lifetime policy', () => {
  test.each([
    { ttlSeconds: 0, absoluteLifetimeSeconds: 3600 },
    { ttlSeconds: -1, absoluteLifetimeSeconds: 3600 },
    { ttlSeconds: 3600, absoluteLifetimeSeconds: 1800 },
    { ttlSeconds: 1.5, absoluteLifetimeSeconds: 3600 },
  ])('rejects invalid policy %p', (policy) => {
    const { sessionStore, profileStore } = makeStores(makeProfile());
    expect(() => createSessionService(sessionStore, profileStore, policy)).toThrow();
  });

  test('trusted exchange enforces the same ttl bound as login', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(
      svc.issueTrustedSession({ accountId: 'agroasys-user:42', role: 'buyer' }, 3601),
    ).rejects.toThrow('ttlSeconds must be an integer between 1 and 3600');
    expect(profileStore.upsertTrustedIdentity).not.toHaveBeenCalled();
    expect(sessionStore.issue).not.toHaveBeenCalled();
  });
});

describe('sessionService.refresh', () => {
  test('rotates the session atomically through the store', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    const result = await svc.refresh('session-abc');
    expect(result.sessionId).toBe('session-successor');
    expect(sessionStore.rotate).toHaveBeenCalledWith('session-abc', profile, LIFETIME);
    expect(sessionStore.issue).not.toHaveBeenCalled();
    expect(sessionStore.revoke).not.toHaveBeenCalled();
  });

  test('throws when a concurrent refresh already rotated the session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    sessionStore.rotate.mockResolvedValue({ status: 'unavailable' });
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.refresh('session-abc')).rejects.toThrow('invalid, expired, or revoked');
  });

  test('throws when the lineage absolute lifetime is exhausted', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    sessionStore.rotate.mockResolvedValue({ status: 'lifetime_exhausted' });
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.refresh('session-abc')).rejects.toThrow('lifetime is exhausted');
  });

  test('throws for expired session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ expiresAt: nowSeconds() - 1 }));
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.refresh('session-abc')).rejects.toThrow('invalid, expired, or revoked');
  });

  test('throws when profile is inactive', async () => {
    const profile = makeProfile({ active: false });
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession());
    profileStore.findById.mockResolvedValue(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.refresh('session-abc')).rejects.toThrow('inactive');
  });

  test('throws for revoked session', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    sessionStore.lookup.mockResolvedValue(makeActiveSession({ revokedAt: nowSeconds() - 5 }));
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await expect(svc.refresh('session-abc')).rejects.toThrow('invalid, expired, or revoked');
  });
});

describe('sessionService.revoke', () => {
  test('delegates to session store', async () => {
    const profile = makeProfile();
    const { sessionStore, profileStore } = makeStores(profile);
    const svc = createSessionService(sessionStore, profileStore, LIFETIME);

    await svc.revoke('session-abc');
    expect(sessionStore.revoke).toHaveBeenCalledWith('session-abc');
  });
});
