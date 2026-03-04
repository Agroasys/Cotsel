/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'buyer' | 'supplier' | 'admin' | 'oracle';

export interface UserProfile {
  id: string;
  walletAddress: string;
  role: UserRole;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
  active: boolean;
}

export interface UserSession {
  sessionId: string;
  userId: string;
  walletAddress: string;
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
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  sessionTtlSeconds: number;
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
