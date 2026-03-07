/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';

export type AuthServiceRole = 'buyer' | 'supplier' | 'admin' | 'oracle';

export interface AuthSession {
  userId: string;
  walletAddress: string;
  role: AuthServiceRole;
  issuedAt: number;
  expiresAt: number;
  email?: string;
}

interface SessionResponse {
  success: boolean;
  data?: AuthSession;
}

export interface AuthSessionClient {
  resolveSession(token: string, requestId?: string): Promise<AuthSession | null>;
  checkReadiness(requestId?: string): Promise<void>;
}

function buildUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl}${pathname}`;
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
        Logger.error('Auth session lookup failed', { requestId, error: error instanceof Error ? error.message : String(error) });
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

      const payload = (await response.json()) as SessionResponse;
      if (!payload.success || !payload.data) {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service returned an invalid session payload');
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
