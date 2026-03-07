/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSession, AuthSessionClient } from '../core/authSessionClient';
import { GatewayError } from '../errors';

export type GatewayRole = 'operator:read' | 'operator:write';

export interface GatewayPrincipal {
  session: AuthSession;
  gatewayRoles: GatewayRole[];
  writeEnabled: boolean;
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}

function mapGatewayRoles(session: AuthSession): GatewayRole[] {
  if (session.role === 'admin') {
    return ['operator:read', 'operator:write'];
  }

  return [];
}

function matchesAllowlist(session: AuthSession, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return false;
  }

  const candidates = [session.userId, session.walletAddress, session.email].filter(Boolean) as string[];
  const normalizedAllowlist = new Set(allowlist.map((entry) => entry.toLowerCase()));
  return candidates.some((entry) => normalizedAllowlist.has(entry.toLowerCase()));
}

export function createAuthenticationMiddleware(client: AuthSessionClient, config: GatewayConfig) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = getBearerToken(req);
    if (!token) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Missing or malformed Authorization header'));
      return;
    }

    const session = await client.resolveSession(token, req.requestContext?.requestId);
    if (!session) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Session invalid, expired, or revoked'));
      return;
    }

    req.gatewayPrincipal = {
      session,
      gatewayRoles: mapGatewayRoles(session),
      writeEnabled: config.enableMutations && matchesAllowlist(session, config.writeAllowlist),
    };

    next();
  };
}

export function requireGatewayRole(role: GatewayRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.gatewayPrincipal?.gatewayRoles.includes(role)) {
      next(new GatewayError(403, 'FORBIDDEN', `Gateway role '${role}' is required`));
      return;
    }

    next();
  };
}

export function requireMutationWriteAccess() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.gatewayPrincipal;
    if (!principal) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required'));
      return;
    }

    if (!principal.gatewayRoles.includes('operator:write')) {
      next(new GatewayError(403, 'FORBIDDEN', 'Admin session is required for gateway mutations'));
      return;
    }

    if (!principal.writeEnabled) {
      next(new GatewayError(403, 'FORBIDDEN', 'Gateway mutations are disabled or caller is not allowlisted', {
        reason: 'disabled_or_not_allowlisted',
      }));
      return;
    }

    next();
  };
}
