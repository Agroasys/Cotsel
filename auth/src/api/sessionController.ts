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
import { SessionService } from '../core/sessionService';
import { ApiErrorResponse, ApiSuccessResponse, UserRole } from '../types';
import { Logger } from '../utils/logger';
import {
  assertWalletAddress,
  handleControllerError,
  parseOptionalSessionTtl,
  requireAuthRole,
} from './controllerSupport';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface TrustedSessionExchangeBody {
  accountId?: string;
  role?: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  ttlSeconds?: number;
}

export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly maxSessionTtlSeconds: number = 86400,
  ) {}

  async refresh(req: Request, res: Response<ApiSuccessResponse | ApiErrorResponse>): Promise<void> {
    const session = req.userSession!;
    try {
      const result = await this.sessionService.refresh(session.sessionId);
      res.json(success(result));
    } catch (error) {
      Logger.error('Session refresh failed', error);
      handleControllerError(res, error, 'Unauthorized', 401, 'Refresh failed');
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

    try {
      const body = requireObject(req.body, 'body') as TrustedSessionExchangeBody;
      normalizedAccountId = requireString(body.accountId, 'accountId');
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
      ttlSeconds = parseOptionalSessionTtl(body.ttlSeconds);
    } catch (error) {
      handleControllerError(
        res,
        error,
        'BadRequest',
        400,
        'Invalid trusted session exchange request',
      );
      return;
    }

    const safeTtl =
      ttlSeconds !== undefined
        ? Math.max(1, Math.min(ttlSeconds, this.maxSessionTtlSeconds))
        : undefined;

    try {
      const result = await this.sessionService.issueTrustedSession(
        {
          accountId: normalizedAccountId,
          role,
          orgId: orgId ?? null,
          email: normalizedEmail,
          walletAddress: normalizedWallet,
        },
        safeTtl,
      );
      Logger.info('Trusted session exchange successful', {
        accountId: normalizedAccountId,
        walletAddress: normalizedWallet,
        email: normalizedEmail,
        role,
      });
      res.status(201).json(success(result));
    } catch (error) {
      Logger.error('Trusted session exchange failed', error);
      handleControllerError(res, error, 'Forbidden', 403, 'Trusted session exchange failed');
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
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
      }),
    );
  }
}
