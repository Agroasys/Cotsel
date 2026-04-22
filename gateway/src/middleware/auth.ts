/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getAddress, isAddress } from 'ethers';
import { GatewayConfig } from '../config/env';
import {
  AuthSession,
  AuthSessionClient,
  SignerActionClass,
  SignerAuthorization,
} from '../core/authSessionClient';
import { GatewayError } from '../errors';

export type GatewayRole = 'operator:read' | 'operator:write';
export type TreasuryCapability =
  | 'treasury:read'
  | 'treasury:prepare'
  | 'treasury:approve'
  | 'treasury:execute_match'
  | 'treasury:close';
export type OperatorActionCapability = 'governance:write' | 'compliance:write';

const TREASURY_CAPABILITIES: readonly TreasuryCapability[] = [
  'treasury:read',
  'treasury:prepare',
  'treasury:approve',
  'treasury:execute_match',
  'treasury:close',
];
const OPERATOR_ACTION_CAPABILITIES: readonly OperatorActionCapability[] = [
  'governance:write',
  'compliance:write',
];

export interface GatewayPrincipal {
  sessionReference: string;
  session: AuthSession;
  gatewayRoles: GatewayRole[];
  operatorActionCapabilities: OperatorActionCapability[];
  treasuryCapabilities: TreasuryCapability[];
  writeEnabled: boolean;
}

export function resolveGatewayActorKey(session: AuthSession): string {
  const normalizedAccountId = session.accountId?.trim();
  if (normalizedAccountId) {
    return `account:${normalizedAccountId}`;
  }

  const normalizedUserId = session.userId?.trim();
  if (normalizedUserId) {
    return `user:${normalizedUserId}`;
  }

  const normalizedWallet = session.walletAddress?.trim().toLowerCase();
  if (normalizedWallet) {
    return `wallet:${normalizedWallet}`;
  }

  throw new GatewayError(
    500,
    'INTERNAL_ERROR',
    'Authenticated session is missing every supported actor identifier',
  );
}

export function requireWalletBoundSession(
  principal: GatewayPrincipal,
  actionDescription: string,
): string {
  const walletAddress = principal.session.walletAddress?.trim().toLowerCase();
  if (!walletAddress) {
    throw new GatewayError(
      409,
      'WALLET_SIGNER_REQUIRED',
      `${actionDescription} requires a wallet-bound admin signer session`,
      {
        reason: 'wallet_signer_required',
      },
    );
  }

  return walletAddress;
}

export function requireSignerWalletAddress(
  raw: string | null | undefined,
  field = 'signerWallet',
): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is required`);
  }

  const candidate = raw.trim();
  if (!isAddress(candidate)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid address`);
  }

  return getAddress(candidate);
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

export function resolveTreasuryCapabilities(session: AuthSession): TreasuryCapability[] {
  if (session.role !== 'admin') {
    return [];
  }

  if (!Array.isArray(session.capabilities)) {
    return [];
  }

  return [
    ...new Set(
      session.capabilities.filter((capability): capability is TreasuryCapability =>
        TREASURY_CAPABILITIES.includes(capability as TreasuryCapability),
      ),
    ),
  ];
}

export function resolveOperatorActionCapabilities(
  session: AuthSession,
): OperatorActionCapability[] {
  if (session.role !== 'admin' || !Array.isArray(session.capabilities)) {
    return [];
  }

  return [
    ...new Set(
      session.capabilities.filter((capability): capability is OperatorActionCapability =>
        OPERATOR_ACTION_CAPABILITIES.includes(capability as OperatorActionCapability),
      ),
    ),
  ];
}

function normalizeSignerAuthorizations(session: AuthSession): SignerAuthorization[] {
  if (!Array.isArray(session.signerAuthorizations)) {
    return [];
  }

  return session.signerAuthorizations
    .filter((binding): binding is SignerAuthorization =>
      Boolean(
        binding &&
        typeof binding.bindingId === 'string' &&
        typeof binding.walletAddress === 'string' &&
        isAddress(binding.walletAddress) &&
        typeof binding.actionClass === 'string' &&
        typeof binding.environment === 'string',
      ),
    )
    .map((binding) => ({
      ...binding,
      walletAddress: getAddress(binding.walletAddress.trim()),
    }));
}

export function matchesAllowlist(session: AuthSession, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return false;
  }

  const candidates = [
    session.accountId,
    session.userId,
    session.walletAddress,
    session.email,
  ].filter(Boolean) as string[];
  const normalizedAllowlist = new Set(allowlist.map((entry) => entry.toLowerCase()));
  return candidates.some((entry) => normalizedAllowlist.has(entry.toLowerCase()));
}

function buildSessionReference(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
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
      sessionReference: buildSessionReference(token),
      session: {
        ...session,
        signerAuthorizations: normalizeSignerAuthorizations(session),
      },
      gatewayRoles: mapGatewayRoles(session),
      operatorActionCapabilities: resolveOperatorActionCapabilities(session),
      treasuryCapabilities: resolveTreasuryCapabilities(session),
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

export function requireTreasuryCapability(capability: TreasuryCapability) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.gatewayPrincipal;
    if (!principal) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required'));
      return;
    }

    if (!principal.treasuryCapabilities.includes(capability)) {
      next(new GatewayError(403, 'FORBIDDEN', `Treasury capability '${capability}' is required`));
      return;
    }

    next();
  };
}

export function requireOperatorActionCapability(capability: OperatorActionCapability) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.gatewayPrincipal;
    if (!principal) {
      next(new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required'));
      return;
    }

    if (!principal.operatorActionCapabilities.includes(capability)) {
      next(new GatewayError(403, 'FORBIDDEN', `Operator capability '${capability}' is required`));
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
      next(
        new GatewayError(
          403,
          'FORBIDDEN',
          'Gateway mutations are disabled or caller is not allowlisted',
          {
            reason: 'disabled_or_not_allowlisted',
          },
        ),
      );
      return;
    }

    next();
  };
}

export function requireAuthorizedSignerBinding(
  principal: GatewayPrincipal,
  config: GatewayConfig,
  actionClass: SignerActionClass,
  signerWallet: string,
  actionDescription: string,
): SignerAuthorization {
  const walletAddress = requireSignerWalletAddress(signerWallet);
  const signerEnvironment = config.operatorSignerEnvironment ?? config.nodeEnv;
  const binding = (principal.session.signerAuthorizations ?? []).find(
    (authorization) =>
      authorization.walletAddress === walletAddress &&
      authorization.actionClass === actionClass &&
      authorization.environment === signerEnvironment,
  );

  if (!binding) {
    throw new GatewayError(
      403,
      'SIGNER_NOT_AUTHORIZED',
      `${actionDescription} requires an approved signer wallet binding for ${actionClass} in ${signerEnvironment}`,
      {
        reason: 'signer_not_authorized',
        signerWallet: walletAddress,
        actionClass,
        environment: signerEnvironment,
      },
    );
  }

  return binding;
}
