/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { verifyMessage } from 'ethers';
import { Request, Response } from 'express';
import { failure, requireObject, requireString, success } from '@agroasys/shared-http';
import { SessionService } from '../core/sessionService';
import { ChallengeStore } from '../core/challengeStore';
import { ApiErrorResponse, ApiSuccessResponse, UserRole } from '../types';
import { Logger } from '../utils/logger';
import { incrementLoginError } from '../metrics/counters';
import {
  assertWalletAddress,
  CHALLENGE_TTL_SECONDS,
  handleControllerError,
  parseOptionalSessionTtl,
  requireAuthRole,
} from './controllerSupport';

interface LoginBody {
  walletAddress?: string;
  signature?: string;
  role?: UserRole;
  orgId?: string;
  ttlSeconds?: number;
}

export class LegacyWalletAuthController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly challengeStore: ChallengeStore,
    private readonly maxSessionTtlSeconds: number = 86400,
  ) {}

  async getChallenge(
    req: Request<unknown, unknown, unknown, { wallet?: string }>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    let wallet: string;
    try {
      wallet = assertWalletAddress(requireString(req.query.wallet, 'wallet'), 'wallet');
    } catch (error) {
      handleControllerError(res, error, 'BadRequest', 400, 'Valid wallet address required');
      return;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    this.challengeStore.set(wallet, nonce, CHALLENGE_TTL_SECONDS);

    Logger.info('Challenge issued', { walletAddress: wallet });
    res.json(
      success({ message: buildChallengeMessage(wallet, nonce), expiresIn: CHALLENGE_TTL_SECONDS }),
    );
  }

  async login(
    req: Request<unknown, unknown, LoginBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    let wallet: string;
    let signature: string;
    let role: UserRole;
    let orgId: string | undefined;
    let ttlSeconds: number | undefined;

    try {
      const body = requireObject(req.body, 'body') as LoginBody;
      wallet = assertWalletAddress(
        requireString(body.walletAddress, 'walletAddress'),
        'walletAddress',
      );
      signature = requireString(body.signature, 'signature');
      role = requireAuthRole(body.role);
      orgId = typeof body.orgId === 'string' && body.orgId.trim() ? body.orgId.trim() : undefined;
      ttlSeconds = parseOptionalSessionTtl(body.ttlSeconds);
    } catch (error) {
      handleControllerError(res, error, 'BadRequest', 400, 'Invalid login request');
      return;
    }

    const nonce = this.challengeStore.get(wallet);
    if (!nonce) {
      res
        .status(401)
        .json(
          failure(
            'Unauthorized',
            'No active challenge for this wallet. Call GET /challenge first.',
          ),
        );
      return;
    }

    try {
      const message = buildChallengeMessage(wallet, nonce);
      const recovered = verifyMessage(message, signature).toLowerCase();

      if (recovered !== wallet) {
        incrementLoginError();
        Logger.warn('Signature verification failed', { walletAddress: wallet });
        res.status(401).json(failure('Unauthorized', 'Signature verification failed'));
        return;
      }
    } catch {
      incrementLoginError();
      res.status(401).json(failure('Unauthorized', 'Invalid signature format'));
      return;
    }

    this.challengeStore.delete(wallet);

    const safeTtl =
      ttlSeconds !== undefined
        ? Math.max(1, Math.min(ttlSeconds, this.maxSessionTtlSeconds))
        : undefined;

    try {
      const result = await this.sessionService.login(wallet, role, orgId, safeTtl);
      Logger.info('Login successful', { walletAddress: wallet, role });
      res.status(201).json(success(result));
    } catch (error) {
      incrementLoginError();
      Logger.error('Login failed', error);
      handleControllerError(res, error, 'Forbidden', 403, 'Login failed');
    }
  }
}

export function buildChallengeMessage(wallet: string, nonce: string): string {
  return `Sign in to Agroasys\nWallet: ${wallet}\nNonce: ${nonce}`;
}
