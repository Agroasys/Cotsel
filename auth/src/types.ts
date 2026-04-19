/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'buyer' | 'supplier' | 'admin' | 'oracle';
export type AdminActorType = 'service_auth' | 'system';
export type AdminAuditAction =
  | 'profile_provisioned'
  | 'profile_role_updated'
  | 'profile_deactivated'
  | 'break_glass_granted'
  | 'break_glass_revoked'
  | 'break_glass_expired'
  | 'break_glass_reviewed';

export interface UserProfile {
  id: string;
  accountId: string;
  walletAddress: string | null;
  email: string | null;
  role: UserRole;
  baseRole: UserRole;
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
  issuedRole?: UserRole;
  active?: boolean;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface SessionIssueResult {
  sessionId: string;
  expiresAt: number;
}

export interface AuthConfig {
  nodeEnv: string;
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbMigrationUser?: string;
  dbMigrationPassword?: string;
  sessionTtlSeconds: number;
  legacyWalletLoginEnabled: boolean;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;
  rateLimitFailOpen: boolean;
  trustedSessionExchangeEnabled: boolean;
  trustedSessionExchangeApiKeysJson: string;
  trustedSessionExchangeMaxSkewSeconds: number;
  trustedSessionExchangeNonceTtlSeconds: number;
  adminControlEnabled: boolean;
  adminControlApiKeysJson: string;
  adminControlAllowedApiKeyIds: string[];
  adminControlMaxSkewSeconds: number;
  adminControlNonceTtlSeconds: number;
  adminBreakGlassMaxTtlSeconds: number;
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
