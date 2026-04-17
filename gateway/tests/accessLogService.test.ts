/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from 'express';
import { AccessLogService, validateAccessLogCreateRequest } from '../src/core/accessLogService';
import { createInMemoryAccessLogStore } from '../src/core/accessLogStore';
import type { GatewayPrincipal } from '../src/middleware/auth';
import type { RequestContext } from '../src/middleware/requestContext';

function buildPrincipal(
  overrides: Omit<Partial<GatewayPrincipal['session']>, 'walletAddress'> & {
    walletAddress?: string | null;
  } = {},
): GatewayPrincipal {
  const session = {
    userId: 'uid-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    role: 'admin',
    email: 'admin@agroasys.io',
    issuedAt: 1,
    expiresAt: 2,
    ...overrides,
  } as GatewayPrincipal['session'];

  return {
    sessionReference: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    session,
    gatewayRoles: ['operator:read', 'operator:write'],
    treasuryCapabilities: [
      'treasury:read',
      'treasury:prepare',
      'treasury:approve',
      'treasury:execute_match',
      'treasury:close',
    ],
    writeEnabled: true,
  };
}

function buildRequestContext(): RequestContext {
  return {
    requestId: 'req-123',
    correlationId: 'corr-123',
    startedAtMs: 1,
  };
}

function buildRequest(): Request {
  return {
    method: 'POST',
    originalUrl: '/api/dashboard-gateway/v1/access-logs',
    path: '/access-logs',
    ip: '::ffff:127.0.0.1',
    get: jest
      .fn()
      .mockImplementation((name: string) =>
        name.toLowerCase() === 'user-agent' ? 'ctsp-dash/1.0' : undefined,
      ),
  } as unknown as Request;
}

describe('AccessLogService', () => {
  test('records access log entries with masked network and session fields', async () => {
    const service = new AccessLogService(
      createInMemoryAccessLogStore(),
      () => new Date('2026-03-14T16:10:00.000Z'),
      () => 'entry-1',
    );

    const entry = await service.record(
      {
        eventType: 'settings.access.granted',
        surface: '/settings/security',
        outcome: 'allowed',
        auditReferences: [{ type: 'governance_action', reference: 'act-1' }],
        metadata: { section: 'security' },
      },
      buildPrincipal(),
      buildRequestContext(),
      buildRequest(),
    );

    expect(entry.entryId).toBe('entry-1');
    expect(entry.actor.sessionFingerprint).toContain('sha256:');
    expect(entry.actor.sessionDisplay).toContain('...');
    expect(entry.network.ipFingerprint).toContain('sha256:');
    expect(entry.network.ipDisplay).toBe('127.0.0.x');
    expect(entry.request.requestId).toBe('req-123');
    expect(entry.auditReferences[0]).toEqual({ type: 'governance_action', reference: 'act-1' });
  });

  test('lists and loads entries with freshness metadata', async () => {
    const service = new AccessLogService(
      createInMemoryAccessLogStore([
        {
          entryId: 'entry-1',
          eventType: 'settings.access.granted',
          surface: '/settings',
          outcome: 'allowed',
          actor: {
            userId: 'uid-admin',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            role: 'admin',
            sessionFingerprint: 'sha256:a',
            sessionDisplay: 'sha256:a...a',
          },
          network: {
            ipFingerprint: 'sha256:b',
            ipDisplay: '127.0.0.x',
            userAgent: 'ctsp-dash/1.0',
          },
          request: {
            requestId: 'req-1',
            correlationId: 'corr-1',
            method: 'POST',
            route: '/api/dashboard-gateway/v1/access-logs',
          },
          auditReferences: [],
          metadata: {},
          createdAt: '2026-03-14T16:00:00.000Z',
        },
      ]),
      () => new Date('2026-03-14T16:11:00.000Z'),
    );

    const list = await service.list({ limit: 10 });
    const detail = await service.get('entry-1');

    expect(list.freshness.available).toBe(true);
    expect(list.freshness.sourceFreshAt).toBe('2026-03-14T16:00:00.000Z');
    expect(detail.item.entryId).toBe('entry-1');
    expect(detail.freshness.queriedAt).toBe('2026-03-14T16:11:00.000Z');
  });

  test('validates access log create payloads', () => {
    expect(() =>
      validateAccessLogCreateRequest({
        eventType: 'bad event',
        surface: '/settings',
        outcome: 'allowed',
      }),
    ).toThrow('eventType contains invalid characters');
  });

  test('records access log entries when the session has no linked wallet', async () => {
    const service = new AccessLogService(
      createInMemoryAccessLogStore(),
      () => new Date('2026-03-14T16:12:00.000Z'),
      () => 'entry-2',
    );

    const entry = await service.record(
      {
        eventType: 'settings.access.viewed',
        surface: '/settings/security',
        outcome: 'allowed',
        auditReferences: [],
        metadata: {},
      },
      buildPrincipal({ walletAddress: null }),
      buildRequestContext(),
      buildRequest(),
    );

    expect(entry.entryId).toBe('entry-2');
    expect(entry.actor.walletAddress).toBeNull();
  });
});
