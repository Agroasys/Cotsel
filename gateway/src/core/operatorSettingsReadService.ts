/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AuditFeedEvent, AuditFeedStore } from './auditFeedStore';
import type { RoleAssignmentRecord, RoleAssignmentStore } from './roleAssignmentStore';

export interface SettingsFreshness {
  source: 'gateway_role_assignments' | 'gateway_audit_log';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
}

export interface RoleAssignmentListSnapshot {
  items: RoleAssignmentRecord[];
  nextCursor: string | null;
  freshness: SettingsFreshness;
}

export interface AuditFeedListSnapshot {
  items: AuditFeedEvent[];
  nextCursor: string | null;
  freshness: SettingsFreshness;
}

function latestAssignedAt(items: RoleAssignmentRecord[]): string | null {
  return items[0]?.assignedAt ?? null;
}

function latestCreatedAt(items: AuditFeedEvent[]): string | null {
  return items[0]?.createdAt ?? null;
}

export class OperatorSettingsReadService {
  constructor(
    private readonly roleAssignmentStore: RoleAssignmentStore,
    private readonly auditFeedStore: AuditFeedStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listRoleAssignments(input: {
    gatewayRole?: string;
    authRole?: string;
    limit: number;
    cursor?: string;
  }): Promise<RoleAssignmentListSnapshot> {
    const result = await this.roleAssignmentStore.list(input);
    return {
      items: result.items,
      nextCursor: result.nextCursor,
      freshness: {
        source: 'gateway_role_assignments',
        sourceFreshAt: latestAssignedAt(result.items),
        queriedAt: this.now().toISOString(),
        available: true,
      },
    };
  }

  async listAuditFeed(input: {
    eventType?: string;
    actorUserId?: string;
    limit: number;
    cursor?: string;
  }): Promise<AuditFeedListSnapshot> {
    const result = await this.auditFeedStore.list(input);
    return {
      items: result.items,
      nextCursor: result.nextCursor,
      freshness: {
        source: 'gateway_audit_log',
        sourceFreshAt: latestCreatedAt(result.items),
        queriedAt: this.now().toISOString(),
        available: true,
      },
    };
  }
}
