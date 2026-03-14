/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';

export const ROLE_ASSIGNMENT_SOURCES = [
  'gateway_seed',
  'manual_sync',
] as const;

export type RoleAssignmentSource = typeof ROLE_ASSIGNMENT_SOURCES[number];

export interface RoleAssignmentRecord {
  assignmentId: string;
  subjectUserId: string;
  subjectWalletAddress: string;
  authRole: string;
  gatewayRoles: string[];
  source: RoleAssignmentSource;
  assignedByUserId: string | null;
  assignedByWalletAddress: string | null;
  assignedAt: string;
  lastVerifiedAt: string | null;
}

export interface RoleAssignmentCursor {
  assignedAt: string;
  assignmentId: string;
}

export interface ListRoleAssignmentsInput {
  gatewayRole?: string;
  authRole?: string;
  limit: number;
  cursor?: string;
}

export interface ListRoleAssignmentsResult {
  items: RoleAssignmentRecord[];
  nextCursor: string | null;
}

export interface RoleAssignmentStore {
  list(input: ListRoleAssignmentsInput): Promise<ListRoleAssignmentsResult>;
}

interface RoleAssignmentRow {
  assignmentId: string;
  subjectUserId: string;
  subjectWalletAddress: string;
  authRole: string;
  gatewayRoles: string[];
  source: RoleAssignmentSource;
  assignedByUserId: string | null;
  assignedByWalletAddress: string | null;
  assignedAt: Date;
  lastVerifiedAt: Date | null;
}

function cloneRecord(record: RoleAssignmentRecord): RoleAssignmentRecord {
  return {
    ...record,
    gatewayRoles: [...record.gatewayRoles],
  };
}

function mapRow(row: RoleAssignmentRow): RoleAssignmentRecord {
  return {
    assignmentId: row.assignmentId,
    subjectUserId: row.subjectUserId,
    subjectWalletAddress: row.subjectWalletAddress,
    authRole: row.authRole,
    gatewayRoles: [...(row.gatewayRoles ?? [])],
    source: row.source,
    assignedByUserId: row.assignedByUserId,
    assignedByWalletAddress: row.assignedByWalletAddress,
    assignedAt: row.assignedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
  };
}

export function encodeRoleAssignmentCursor(cursor: RoleAssignmentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeRoleAssignmentCursor(cursor: string): RoleAssignmentCursor {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as RoleAssignmentCursor;
  if (!parsed.assignedAt || !parsed.assignmentId) {
    throw new Error('Cursor is missing required fields');
  }

  if (Number.isNaN(Date.parse(parsed.assignedAt))) {
    throw new Error('Cursor assignedAt must be an ISO timestamp');
  }

  return parsed;
}

function nextCursorFromItems(items: RoleAssignmentRecord[], limit: number): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeRoleAssignmentCursor({
    assignedAt: boundary.assignedAt,
    assignmentId: boundary.assignmentId,
  });
}

export function createPostgresRoleAssignmentStore(pool: Pool): RoleAssignmentStore {
  const selectColumns = `SELECT
    assignment_id AS "assignmentId",
    subject_user_id AS "subjectUserId",
    subject_wallet_address AS "subjectWalletAddress",
    auth_role AS "authRole",
    gateway_roles AS "gatewayRoles",
    source,
    assigned_by_user_id AS "assignedByUserId",
    assigned_by_wallet_address AS "assignedByWalletAddress",
    assigned_at AS "assignedAt",
    last_verified_at AS "lastVerifiedAt"`;

  return {
    async list(input) {
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (input.gatewayRole) {
        values.push(input.gatewayRole);
        conditions.push(`gateway_roles ? $${values.length}`);
      }

      if (input.authRole) {
        values.push(input.authRole);
        conditions.push(`auth_role = $${values.length}`);
      }

      if (input.cursor) {
        const cursor = decodeRoleAssignmentCursor(input.cursor);
        values.push(cursor.assignedAt);
        const assignedAtIndex = values.length;
        values.push(cursor.assignmentId);
        const assignmentIdIndex = values.length;
        conditions.push(`(assigned_at < $${assignedAtIndex}::timestamp OR (assigned_at = $${assignedAtIndex}::timestamp AND assignment_id < $${assignmentIdIndex}))`);
      }

      values.push(input.limit + 1);
      const limitIndex = values.length;

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query<RoleAssignmentRow>(
        `${selectColumns}
         FROM role_assignments
         ${whereClause}
         ORDER BY assigned_at DESC, assignment_id DESC
         LIMIT $${limitIndex}`,
        values,
      );

      const mapped = result.rows.map(mapRow);
      return {
        items: mapped.slice(0, input.limit),
        nextCursor: nextCursorFromItems(mapped, input.limit),
      };
    },
  };
}

export function createInMemoryRoleAssignmentStore(initial: RoleAssignmentRecord[] = []): RoleAssignmentStore {
  const items = initial.map(cloneRecord);

  function sorted(): RoleAssignmentRecord[] {
    return [...items].sort((left, right) => {
      if (left.assignedAt === right.assignedAt) {
        return right.assignmentId.localeCompare(left.assignmentId);
      }

      return right.assignedAt.localeCompare(left.assignedAt);
    });
  }

  return {
    async list(input) {
      let candidates = sorted();

      if (input.gatewayRole) {
        candidates = candidates.filter((record) => record.gatewayRoles.includes(input.gatewayRole!));
      }

      if (input.authRole) {
        candidates = candidates.filter((record) => record.authRole === input.authRole);
      }

      if (input.cursor) {
        const cursor = decodeRoleAssignmentCursor(input.cursor);
        candidates = candidates.filter((record) => (
          record.assignedAt < cursor.assignedAt
          || (record.assignedAt === cursor.assignedAt && record.assignmentId < cursor.assignmentId)
        ));
      }

      const page = candidates.slice(0, input.limit + 1);
      return {
        items: page.slice(0, input.limit).map(cloneRecord),
        nextCursor: nextCursorFromItems(page, input.limit),
      };
    },
  };
}
