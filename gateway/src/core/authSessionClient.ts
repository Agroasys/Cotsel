/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';

export type AuthServiceRole = 'buyer' | 'supplier' | 'admin' | 'oracle';
export type OperatorCapability =
  | 'governance:write'
  | 'compliance:write'
  | 'treasury:read'
  | 'treasury:prepare'
  | 'treasury:approve'
  | 'treasury:execute_match'
  | 'treasury:close';
export type SignerActionClass =
  | 'governance'
  | 'treasury_approve'
  | 'treasury_execute'
  | 'treasury_close'
  | 'compliance_sensitive'
  | 'emergency_admin';

export interface SignerAuthorization {
  bindingId: string;
  walletAddress: string;
  actionClass: SignerActionClass;
  environment: string;
  approvedAt: string;
  approvedBy: string;
  ticketRef: string | null;
  notes: string | null;
}

export interface AuthSession {
  userId: string;
  accountId?: string;
  walletAddress: string | null;
  role: AuthServiceRole;
  capabilities: OperatorCapability[];
  signerAuthorizations: SignerAuthorization[];
  issuedAt: number;
  expiresAt: number;
  email?: string | null;
}

interface SessionResponse {
  success: boolean;
  data?: AuthSession;
}

export interface AuthSessionClient {
  resolveSession(token: string, requestId?: string): Promise<AuthSession | null>;
  checkReadiness(requestId?: string): Promise<void>;
}

const AUTH_SERVICE_ROLES: AuthServiceRole[] = ['buyer', 'supplier', 'admin', 'oracle'];
const OPERATOR_CAPABILITIES: OperatorCapability[] = [
  'governance:write',
  'compliance:write',
  'treasury:read',
  'treasury:prepare',
  'treasury:approve',
  'treasury:execute_match',
  'treasury:close',
];
const SIGNER_ACTION_CLASSES: SignerActionClass[] = [
  'governance',
  'treasury_approve',
  'treasury_execute',
  'treasury_close',
  'compliance_sensitive',
  'emergency_admin',
];

function buildUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl}${pathname}`;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

function isKnownValue<T extends string>(allowedValues: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

function isSignerAuthorization(value: unknown): value is SignerAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.bindingId === 'string' &&
    typeof candidate.walletAddress === 'string' &&
    isKnownValue(SIGNER_ACTION_CLASSES, candidate.actionClass) &&
    typeof candidate.environment === 'string' &&
    typeof candidate.approvedAt === 'string' &&
    typeof candidate.approvedBy === 'string' &&
    isStringOrNull(candidate.ticketRef) &&
    isStringOrNull(candidate.notes)
  );
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === 'string' &&
    isOptionalStringOrNull(candidate.accountId) &&
    isStringOrNull(candidate.walletAddress) &&
    isKnownValue(AUTH_SERVICE_ROLES, candidate.role) &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.every((capability) => isKnownValue(OPERATOR_CAPABILITIES, capability)) &&
    Array.isArray(candidate.signerAuthorizations) &&
    candidate.signerAuthorizations.every(isSignerAuthorization) &&
    typeof candidate.issuedAt === 'number' &&
    Number.isFinite(candidate.issuedAt) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    isOptionalStringOrNull(candidate.email)
  );
}

export function createAuthSessionClient(config: GatewayConfig): AuthSessionClient {
  return {
    async resolveSession(token, requestId) {
      const response = await fetch(buildUrl(config.authBaseUrl, '/api/auth/v1/session'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        signal: AbortSignal.timeout(config.authRequestTimeoutMs),
      }).catch((error) => {
        Logger.error('Auth session lookup failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service is unavailable');
      });

      if (response.status === 401) {
        return null;
      }

      if (!response.ok) {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service session lookup failed', {
          upstreamStatus: response.status,
        });
      }

      const payload = (await response.json().catch(() => null)) as SessionResponse | null;
      if (!payload?.success || !isAuthSession(payload.data)) {
        throw new GatewayError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'Auth service returned an invalid session payload',
        );
      }

      return payload.data;
    },

    async checkReadiness(requestId) {
      const response = await fetch(buildUrl(config.authBaseUrl, '/api/auth/v1/health'), {
        method: 'GET',
        headers: requestId ? { 'x-request-id': requestId } : undefined,
        signal: AbortSignal.timeout(config.authRequestTimeoutMs),
      }).catch(() => {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service is unavailable');
      });

      if (!response.ok) {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service readiness check failed', {
          upstreamStatus: response.status,
        });
      }
    },
  };
}
