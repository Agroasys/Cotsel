/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'buyer' | 'supplier' | 'admin' | 'oracle';

export interface UserProfile {
  id: string;
  accountId: string;
  walletAddress: string | null;
  email: string | null;
  role: UserRole;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
  active: boolean;
}

export interface UserSession {
  sessionId: string;
  accountId: string;
  userId: string;
  walletAddress: string | null;
  email: string | null;
  role: UserRole;
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
  trustedSessionExchangeEnabled: boolean;
  trustedSessionExchangeApiKeysJson: string;
  trustedSessionExchangeMaxSkewSeconds: number;
  trustedSessionExchangeNonceTtlSeconds: number;
}

export interface TrustedSessionIdentity {
  accountId: string;
  role: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
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
