/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BreakGlassSessionContext,
  OPERATOR_CAPABILITIES,
  OPERATOR_SIGNER_ACTION_CLASSES,
  OperatorCapability,
  OperatorSignerAuthorization,
  UserRole,
  UserSession,
} from '../../types';
import { resolveBreakGlassReviewStatus } from '../../core/breakGlassReviewStatus';

export type SessionRow = Omit<
  UserSession,
  'issuedAt' | 'expiresAt' | 'revokedAt' | 'capabilities' | 'signerAuthorizations' | 'breakGlass'
> & {
  issuedAt: number | string;
  expiresAt: number | string;
  revokedAt: number | string | null;
  breakGlassRole?: 'admin' | null;
  breakGlassExpiresAt?: Date | string | null;
  breakGlassGrantedAt?: Date | string | null;
  breakGlassGrantedBy?: string | null;
  breakGlassReason?: string | null;
  breakGlassRevokedAt?: Date | string | null;
  breakGlassRevokedBy?: string | null;
  breakGlassReviewedAt?: Date | string | null;
  breakGlassReviewedBy?: string | null;
};

function parseSessionEpoch(
  value: number | string,
  field: 'issuedAt' | 'expiresAt' | 'revokedAt',
): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid ${field} session timestamp returned from database`);
}

function deriveOperatorCapabilities(role: UserRole): OperatorCapability[] {
  return role === 'admin' ? [...OPERATOR_CAPABILITIES] : [];
}

function deriveSignerAuthorizations(
  role: UserRole,
  walletAddress: string | null,
  approvedAtIso: string,
): OperatorSignerAuthorization[] {
  if (role !== 'admin' || !walletAddress) {
    return [];
  }

  return OPERATOR_SIGNER_ACTION_CLASSES.map((actionClass) => ({
    bindingId: `admin-role:${actionClass}`,
    walletAddress,
    actionClass,
    environment: '*',
    approvedAt: approvedAtIso,
    approvedBy: 'durable-admin-role',
    ticketRef: null,
    notes: 'Derived from durable admin role',
  }));
}

function timestampIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid break-glass timestamp returned from database: ${value}`);
  }

  return parsed.toISOString();
}

function normalizeBreakGlassContext(row: SessionRow): BreakGlassSessionContext {
  const expiresAt = timestampIsoOrNull(row.breakGlassExpiresAt);
  const revokedAt = timestampIsoOrNull(row.breakGlassRevokedAt);
  const reviewedAt = timestampIsoOrNull(row.breakGlassReviewedAt);
  const grantedAt = timestampIsoOrNull(row.breakGlassGrantedAt);
  const active =
    row.breakGlassRole === 'admin' &&
    expiresAt !== null &&
    Date.parse(expiresAt) > Date.now() &&
    revokedAt === null;

  return {
    active,
    role: row.breakGlassRole ?? null,
    expiresAt,
    grantedAt,
    grantedBy: row.breakGlassGrantedBy ?? null,
    reason: row.breakGlassReason ?? null,
    revokedAt,
    revokedBy: row.breakGlassRevokedBy ?? null,
    reviewedAt,
    reviewedBy: row.breakGlassReviewedBy ?? null,
    reviewStatus: resolveBreakGlassReviewStatus({
      active,
      role: row.breakGlassRole ?? null,
      expiresAt,
      grantedAt,
      revokedAt,
      reviewedAt,
    }),
  };
}

export function normalizeSessionRow(row: SessionRow): UserSession {
  const issuedAt = parseSessionEpoch(row.issuedAt, 'issuedAt');
  return {
    sessionId: row.sessionId,
    accountId: row.accountId,
    userId: row.userId,
    walletAddress: row.walletAddress,
    email: row.email,
    role: row.role,
    issuedRole: row.issuedRole,
    active: row.active,
    capabilities: deriveOperatorCapabilities(row.role),
    signerAuthorizations: deriveSignerAuthorizations(
      row.role,
      row.walletAddress,
      new Date(issuedAt * 1000).toISOString(),
    ),
    breakGlass: normalizeBreakGlassContext(row),
    issuedAt,
    expiresAt: parseSessionEpoch(row.expiresAt, 'expiresAt'),
    revokedAt: row.revokedAt === null ? null : parseSessionEpoch(row.revokedAt, 'revokedAt'),
  };
}
