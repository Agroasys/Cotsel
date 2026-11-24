/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Response } from 'express';
import {
  HttpError,
  optionalNullableString,
  requireObject,
  requireString,
  success,
} from '@agroasys/shared-http';
import { ExchangeAuthority, ExchangeAuthorityError } from '../core/exchangeAuthority';
import { SessionService } from '../core/sessionService';
import {
  ApiErrorResponse,
  ApiSuccessResponse,
  AUTHENTICATION_METHODS,
  AUTHENTICATION_STRENGTHS,
  AuthenticationAssurance,
  NO_AUTHENTICATION_ASSURANCE,
  UserRole,
} from '../types';
import { Logger } from '../utils/logger';
import {
  assertWalletAddress,
  handleControllerError,
  parseOptionalSessionTtl,
  requireAuthRole,
} from './controllerSupport';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Upstream clocks may lead ours slightly; an authTime further ahead is invalid. */
export const AUTH_TIME_MAX_FUTURE_SKEW_SECONDS = 60;

/**
 * Validates the optional authentication assurance in a trusted exchange body
 * (agroasys-backend#797, fixture cotsel-session-exchange.v1). Absent claims
 * leave the session without assurance; present but invalid claims fail the
 * exchange rather than being dropped.
 */
export function parseAuthenticationAssurance(
  body: TrustedSessionExchangeBody,
  nowSeconds: number,
): AuthenticationAssurance {
  const { authTime, authMethod, authStrength } = body;
  if (authTime === undefined && authMethod === undefined && authStrength === undefined) {
    return NO_AUTHENTICATION_ASSURANCE;
  }
  if (authTime !== undefined) {
    if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0) {
      throw new HttpError(400, 'BadRequest', 'authTime must be a positive Unix time in seconds');
    }
    if (authTime > nowSeconds + AUTH_TIME_MAX_FUTURE_SKEW_SECONDS) {
      throw new HttpError(400, 'BadRequest', 'authTime is in the future');
    }
  }
  if (
    authMethod !== undefined &&
    !(AUTHENTICATION_METHODS as readonly unknown[]).includes(authMethod)
  ) {
    throw new HttpError(400, 'BadRequest', 'authMethod is not a recognised authentication method');
  }
  if (
    authStrength !== undefined &&
    !(AUTHENTICATION_STRENGTHS as readonly unknown[]).includes(authStrength)
  ) {
    throw new HttpError(
      400,
      'BadRequest',
      'authStrength is not a recognised authentication strength',
    );
  }
  return {
    authTime: authTime ?? null,
    method: (authMethod as AuthenticationAssurance['method']) ?? null,
    strength: (authStrength as AuthenticationAssurance['strength']) ?? null,
  };
}
const INACTIVE_BREAK_GLASS_CONTEXT = {
  active: false,
  role: null,
  expiresAt: null,
  grantedAt: null,
  grantedBy: null,
  reason: null,
  revokedAt: null,
  revokedBy: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewStatus: 'none',
} as const;

export interface TrustedSessionExchangeBody {
  accountId?: string;
  role?: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  ttlSeconds?: number;
  authTime?: unknown;
  authMethod?: unknown;
  authStrength?: unknown;
}

export class SessionController {
  /**
   * `exchangeAuthorityFor` maps the authenticated exchange key ID to the
   * authority that key may confer. A key without one is refused.
   */
  constructor(
    private readonly sessionService: SessionService,
    private readonly maxSessionTtlSeconds: number = 86400,
    private readonly exchangeAuthorityFor: (keyId: string) => ExchangeAuthority | undefined = () =>
      undefined,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async refresh(req: Request, res: Response<ApiSuccessResponse | ApiErrorResponse>): Promise<void> {
    const session = req.userSession!;
    try {
      const result = await this.sessionService.refresh(session.sessionId);
      res.json(success(result));
    } catch (error) {
      Logger.error('Session refresh failed', error);
      handleControllerError(req, res, error, 'Unauthorized', 401, 'Refresh failed');
    }
  }

  async exchangeTrustedSession(
    req: Request<unknown, unknown, TrustedSessionExchangeBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    let normalizedAccountId: string;
    let role: UserRole;
    let orgId: string | null | undefined;
    let normalizedEmail: string | null;
    let normalizedWallet: string | null;
    let ttlSeconds: number | undefined;
    let authentication: AuthenticationAssurance;

    try {
      const body = requireObject(req.body, 'body') as TrustedSessionExchangeBody;
      normalizedAccountId = requireString(body.accountId, 'accountId');
      if (body.role === 'oracle') {
        throw new HttpError(403, 'Forbidden', 'Session exchange may not issue the oracle role');
      }
      role = requireAuthRole(body.role);
      orgId = optionalNullableString(body.orgId, 'orgId');
      const email = optionalNullableString(body.email, 'email');
      normalizedEmail = email === undefined || email === null ? null : email.toLowerCase();
      if (normalizedEmail && !EMAIL_REGEX.test(normalizedEmail)) {
        throw new HttpError(400, 'BadRequest', 'email must be a valid email address');
      }
      const walletAddress = optionalNullableString(body.walletAddress, 'walletAddress');
      normalizedWallet =
        walletAddress === undefined || walletAddress === null
          ? null
          : assertWalletAddress(walletAddress, 'walletAddress');
      ttlSeconds = parseOptionalSessionTtl(body.ttlSeconds, this.maxSessionTtlSeconds);
      authentication = parseAuthenticationAssurance(body, this.nowSeconds());
    } catch (error) {
      handleControllerError(
        req,
        res,
        error,
        'BadRequest',
        400,
        'Invalid trusted session exchange request',
      );
      return;
    }

    const keyId = req.serviceAuth?.apiKeyId;
    const authority = keyId ? this.exchangeAuthorityFor(keyId) : undefined;
    if (!authority) {
      Logger.warn('Trusted session exchange refused', {
        eventType: 'auth.exchange_authority_denied',
        exchangeKeyId: keyId ?? null,
        requestedRole: role,
        reason: 'no_key_policy',
      });
      handleControllerError(
        req,
        res,
        new HttpError(403, 'Forbidden', 'Exchange key has no session authority policy'),
        'Forbidden',
        403,
        'Trusted session exchange failed',
      );
      return;
    }

    try {
      const result = await this.sessionService.issueTrustedSession(
        {
          accountId: normalizedAccountId,
          role,
          orgId: orgId ?? null,
          email: normalizedEmail,
          walletAddress: normalizedWallet,
        },
        authority,
        ttlSeconds,
        authentication,
      );
      Logger.info('Trusted session exchange successful', { role });
      res.status(201).json(success(result));
    } catch (error) {
      if (error instanceof ExchangeAuthorityError) {
        Logger.warn('Trusted session exchange refused', {
          eventType: 'auth.exchange_authority_denied',
          exchangeKeyId: authority.keyId,
          requestedRole: role,
          reason: error.message,
        });
      } else {
        Logger.error('Trusted session exchange failed', error);
      }
      handleControllerError(
        req,
        res,
        error instanceof ExchangeAuthorityError
          ? new HttpError(403, 'Forbidden', error.message)
          : error,
        'Forbidden',
        403,
        'Trusted session exchange failed',
      );
    }
  }

  async revoke(req: Request, res: Response<ApiSuccessResponse | ApiErrorResponse>): Promise<void> {
    const session = req.userSession!;
    await this.sessionService.revoke(session.sessionId);
    res.json(success({ revoked: true }));
  }

  getSession(req: Request, res: Response<ApiSuccessResponse | ApiErrorResponse>): void {
    const session = req.userSession!;
    res.json(
      success({
        accountId: session.accountId,
        userId: session.userId,
        walletAddress: session.walletAddress,
        email: session.email,
        role: session.role,
        capabilities: session.capabilities,
        signerAuthorizations: session.signerAuthorizations,
        breakGlass: session.breakGlass ?? INACTIVE_BREAK_GLASS_CONTEXT,
        authentication: session.authentication ?? NO_AUTHENTICATION_ASSURANCE,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
      }),
    );
  }
}
