/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditFeedStore, encodeAuditFeedCursor } from '../src/core/auditFeedStore';
import { OperatorSettingsReadService } from '../src/core/operatorSettingsReadService';
import { createInMemoryRoleAssignmentStore } from '../src/core/roleAssignmentStore';

describe('OperatorSettingsReadService', () => {
  test('returns role assignments and audit feed with freshness metadata', async () => {
    const service = new OperatorSettingsReadService(
      createInMemoryRoleAssignmentStore([
        {
          assignmentId: 'ra-1',
          subjectUserId: 'uid-admin',
          subjectWalletAddress: '0x00000000000000000000000000000000000000aa',
          authRole: 'admin',
          gatewayRoles: ['operator:read', 'operator:write'],
          source: 'manual_sync',
          assignedByUserId: 'uid-owner',
          assignedByWalletAddress: '0x00000000000000000000000000000000000000cc',
          assignedAt: '2026-03-14T10:00:00.000Z',
          lastVerifiedAt: '2026-03-14T12:00:00.000Z',
        },
      ]),
      createInMemoryAuditFeedStore([
        {
          eventId: '1',
          eventType: 'governance.action.recorded',
          route: '/api/dashboard-gateway/v1/governance/pause',
          method: 'POST',
          requestId: 'req-1',
          correlationId: 'corr-1',
          actor: {
            userId: 'uid-admin',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            role: 'admin',
          },
          status: 'accepted',
          metadata: { category: 'pause' },
          source: 'audit_log',
          createdAt: '2026-03-14T11:00:00.000Z',
        },
      ]),
      () => new Date('2026-03-14T16:20:00.000Z'),
    );

    const roles = await service.listRoleAssignments({ limit: 10 });
    const auditFeed = await service.listAuditFeed({ limit: 10 });

    expect(roles.freshness.source).toBe('gateway_role_assignments');
    expect(roles.freshness.sourceFreshAt).toBe('2026-03-14T10:00:00.000Z');
    expect(auditFeed.freshness.source).toBe('gateway_audit_log');
    expect(auditFeed.freshness.sourceFreshAt).toBe('2026-03-14T11:00:00.000Z');
    expect(auditFeed.items[0]?.actor.userId).toBe('uid-admin');
  });

  test('paginates audit feed entries with bigint-safe ids', async () => {
    const service = new OperatorSettingsReadService(
      createInMemoryRoleAssignmentStore(),
      createInMemoryAuditFeedStore([
        {
          eventId: '9007199254740994',
          eventType: 'governance.action.recorded',
          route: '/api/dashboard-gateway/v1/governance/pause',
          method: 'POST',
          requestId: 'req-2',
          correlationId: 'corr-2',
          actor: {
            userId: 'uid-admin',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            role: 'admin',
          },
          status: 'accepted',
          metadata: { category: 'pause' },
          source: 'audit_log',
          createdAt: '2026-03-14T11:00:00.000Z',
        },
        {
          eventId: '9007199254740993',
          eventType: 'governance.action.recorded',
          route: '/api/dashboard-gateway/v1/governance/pause',
          method: 'POST',
          requestId: 'req-1',
          correlationId: 'corr-1',
          actor: {
            userId: 'uid-admin',
            walletAddress: '0x00000000000000000000000000000000000000aa',
            role: 'admin',
          },
          status: 'accepted',
          metadata: { category: 'pause' },
          source: 'audit_log',
          createdAt: '2026-03-14T11:00:00.000Z',
        },
      ]),
      () => new Date('2026-03-14T16:20:00.000Z'),
    );

    const page = await service.listAuditFeed({ limit: 1 });
    const nextPage = await service.listAuditFeed({
      limit: 1,
      cursor: encodeAuditFeedCursor({
        createdAt: page.items[0]!.createdAt,
        eventId: page.items[0]!.eventId,
      }),
    });

    expect(page.items[0]?.eventId).toBe('9007199254740994');
    expect(nextPage.items[0]?.eventId).toBe('9007199254740993');
  });
});
