/**
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PostgresSslMode } from '@agroasys/shared-db';

export type UserRole = 'buyer' | 'supplier' | 'admin' | 'oracle';
export type AdminActorType = 'service_auth' | 'system';
export const OPERATOR_CAPABILITIES = [
  'governance:write',
  'compliance:write',
  'operations:replay',
  'treasury:read',
  'treasury:prepare',
  'treasury:approve',
  'treasury:execute_match',
  'treasury:close',
] as const;
export type OperatorCapability = (typeof OPERATOR_CAPABILITIES)[number];
export const OPERATOR_SIGNER_ACTION_CLASSES = [
  'governance',
  'treasury_approve',
  'treasury_execute',
  'treasury_close',
  'compliance_sensitive',
  'emergency_admin',
] as const;
export type OperatorSignerActionClass = (typeof OPERATOR_SIGNER_ACTION_CLASSES)[number];
export type AdminAuditAction =
  | 'profile_provisioned'
  | 'profile_role_updated'
  | 'profile_deactivated'
  | 'break_glass_granted'
  | 'break_glass_revoked'
  | 'break_glass_expired'
  | 'break_glass_reviewed'
  | 'operator_capabilities_updated'
  | 'signer_binding_provisioned'
  | 'signer_binding_proposed'
  | 'signer_binding_activated'
  | 'signer_binding_revoked'
  | 'admin_authority_change_proposed'
  | 'admin_authority_change_applied'
  | 'admin_authority_change_cancelled';

export type AdminAuthorityChangeKind = 'grant' | 'revoke';

/**
 * A two-person change to durable administrator authority. A `grant` makes the
 * account an administrator in one environment until `grantExpiresAt`; a
 * `revoke` returns it to `resultingRole`. It applies only when a principal
 * other than the proposer approves its exact `evidenceDigest`.
 */
export interface AdminAuthorityChangeRecord {
  changeId: string;
  accountId: string;
  change: AdminAuthorityChangeKind;
  environment: string;
  orgId: string | null;
  grantExpiresAt: string | null;
  resultingRole: UserRole;
  approvalTicket: string;
  reason: string;
  evidenceDigest: string;
  state: 'pending' | 'applied' | 'cancelled';
  proposedBy: string;
  proposedByKey: string;
  proposedAt: string;
  appliedBy: string | null;
  appliedByKey: string | null;
  appliedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
}

export interface UserProfile {
  id: string;
  accountId: string;
  walletAddress: string | null;
  email: string | null;
  role: UserRole;
  baseRole: UserRole;
  /**
   * True when a durable `admin` base role is backed by an active, unexpired
   * two-person admin grant in this environment. Absent or false means the base
   * role confers no admin authority.
   */
  adminProvisioned?: boolean;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
  active: boolean;
  breakGlassRole: 'admin' | null;
  breakGlassExpiresAt: Date | null;
  breakGlassGrantedAt: Date | null;
  breakGlassGrantedBy: string | null;
  breakGlassReason: string | null;
  breakGlassRevokedAt: Date | null;
  breakGlassRevokedBy: string | null;
  breakGlassReviewedAt: Date | null;
  breakGlassReviewedBy: string | null;
}

export interface UserSession {
  sessionId: string;
  accountId: string;
  userId: string;
  walletAddress: string | null;
  email: string | null;
  role: UserRole;
  capabilities: OperatorCapability[];
  signerAuthorizations: OperatorSignerAuthorization[];
  issuedRole?: UserRole;
  active?: boolean;
  /** The profile's durable `admin` base role has no active grant in this environment. */
  adminGrantMissing?: boolean;
  breakGlass?: BreakGlassSessionContext;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export type BreakGlassReviewStatus =
  'none' | 'active_unreviewed' | 'revoked_unreviewed' | 'expired_unreviewed' | 'reviewed';

export interface BreakGlassSessionContext {
  active: boolean;
  role: 'admin' | null;
  expiresAt: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
  reason: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewStatus: BreakGlassReviewStatus;
}

export interface OperatorSignerAuthorization {
  bindingId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  approvedAt: string;
  approvedBy: string;
  ticketRef: string | null;
  notes: string | null;
}

export interface OperatorSignerRegisterRecord {
  bindingId: string;
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvingAuthority: string | null;
  approvedAt: string | null;
  approvalTicket: string;
  notes: string | null;
  state: 'pending' | 'active' | 'revoked';
  evidenceDigest: string;
  approvedByPrincipal: string | null;
  activatedAt: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export interface SessionIssueResult {
  sessionId: string;
  expiresAt: number;
}

/**
 * One lifetime policy for login, trusted exchange, and refresh. `ttlSeconds`
 * bounds each issued session; `absoluteLifetimeSeconds` bounds the whole
 * refresh lineage from its first issuance.
 */
export interface SessionLifetimePolicy {
  ttlSeconds: number;
  absoluteLifetimeSeconds: number;
}

export interface AuthConfig {
  nodeEnv: string;
  /** Cotsel environment (`COTSEL_ENVIRONMENT`); admin grants are bound to it. */
  environment: string;
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: PostgresSslMode;
  sessionTtlSeconds: number;
  sessionAbsoluteLifetimeSeconds: number;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;
  rateLimitFailOpen: boolean;
  trustedSessionExchangeEnabled: boolean;
  trustedSessionExchangeApiKeysJson: string;
  trustedSessionExchangeKeyPoliciesJson: string;
  trustedSessionExchangeMaxSkewSeconds: number;
  trustedSessionExchangeNonceTtlSeconds: number;
  adminControlEnabled: boolean;
  adminControlApiKeysJson: string;
  adminControlAllowedApiKeyIds: string[];
  adminControlMaxSkewSeconds: number;
  adminControlNonceTtlSeconds: number;
  adminBreakGlassMaxTtlSeconds: number;
  adminGrantMaxTtlSeconds: number;
}

export interface TrustedSessionIdentity {
  accountId: string;
  role: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
}

export interface AdminActor {
  type: AdminActorType;
  id: string;
  humanPrincipalId?: string;
}

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  message: string;
  timestamp: string;
}
