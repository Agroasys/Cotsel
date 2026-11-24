/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  AUTHENTICATION_METHODS,
  AUTHENTICATION_STRENGTHS,
  AuthenticationAssurance,
  BreakGlassSessionContext,
  OPERATOR_CAPABILITIES,
  OperatorCapability,
  OperatorSignerAuthorization,
  UserRole,
  UserSession,
} from '../../types';
import { resolveBreakGlassReviewStatus } from '../../core/breakGlassReviewStatus';

export type SessionRow = Omit<
  UserSession,
  | 'issuedAt'
  | 'expiresAt'
  | 'revokedAt'
  | 'capabilities'
  | 'signerAuthorizations'
  | 'breakGlass'
  | 'authentication'
> & {
  authTime?: number | string | null;
  authMethod?: string | null;
  authStrength?: string | null;
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
  signerAuthorizations?: OperatorSignerAuthorization[] | null;
};

function parseSessionEpoch(
  value: number | string,
  field: 'issuedAt' | 'expiresAt' | 'revokedAt' | 'authTime',
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

/**
 * The database constrains these columns, but an unexpected value is still
 * rejected rather than passed on as assurance.
 */
function normalizeAuthentication(row: SessionRow): AuthenticationAssurance {
  const method = row.authMethod ?? null;
  const strength = row.authStrength ?? null;
  if (method !== null && !(AUTHENTICATION_METHODS as readonly string[]).includes(method)) {
    throw new Error('Invalid authentication method returned from database');
  }
  if (strength !== null && !(AUTHENTICATION_STRENGTHS as readonly string[]).includes(strength)) {
    throw new Error('Invalid authentication strength returned from database');
  }
  return {
    authTime:
      row.authTime === null || row.authTime === undefined
        ? null
        : parseSessionEpoch(row.authTime, 'authTime'),
    method: method as AuthenticationAssurance['method'],
    strength: strength as AuthenticationAssurance['strength'],
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
    adminGrantMissing: row.adminGrantMissing,
    capabilities: deriveOperatorCapabilities(row.role),
    signerAuthorizations: row.role === 'admin' ? [...(row.signerAuthorizations ?? [])] : [],
    breakGlass: normalizeBreakGlassContext(row),
    authentication: normalizeAuthentication(row),
    issuedAt,
    expiresAt: parseSessionEpoch(row.expiresAt, 'expiresAt'),
    revokedAt: row.revokedAt === null ? null : parseSessionEpoch(row.revokedAt, 'revokedAt'),
  };
}
