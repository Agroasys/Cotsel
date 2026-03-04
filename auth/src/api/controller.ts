/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { verifyMessage } from 'ethers';
import { Request, Response } from 'express';
import { SessionService } from '../core/sessionService';
import { ChallengeStore } from '../core/challengeStore';
import { UserRole, ApiSuccessResponse, ApiErrorResponse } from '../types';
import { Logger } from '../utils/logger';
import { incrementLoginError } from '../metrics/counters';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const WALLET_REGEX = /^0x[0-9a-f]{40}$/i;
const VALID_ROLES: UserRole[] = ['buyer', 'supplier', 'admin'];

interface LoginBody {
  walletAddress?: string;
  signature?: string;
  role?: UserRole;
  orgId?: string;
  ttlSeconds?: number;
}

export class AuthController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly challengeStore: ChallengeStore,
  ) {}

  /**
   * GET /challenge?wallet=0x...
   * Issues a one-time nonce the user must sign with their wallet.
   * Called by the browser before login — no authentication required.
   */
  async getChallenge(
    req: Request<unknown, unknown, unknown, { wallet?: string }>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    const wallet = req.query.wallet?.toLowerCase();

    if (!wallet || !WALLET_REGEX.test(wallet)) {
      res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Valid wallet address required (?wallet=0x...)',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    this.challengeStore.set(wallet, nonce, CHALLENGE_TTL_SECONDS);

    const message = buildChallengeMessage(wallet, nonce);
    Logger.info('Challenge issued', { walletAddress: wallet });

    res.json({
      success: true,
      data: { message, expiresIn: CHALLENGE_TTL_SECONDS },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * POST /login
   * Verifies the wallet signature and issues a platform session.
   * No HMAC needed — the wallet signature proves ownership of the address.
   *
   * Flow:
   *   1. GET /challenge?wallet=0x...  → receive { message }
   *   2. signer.signMessage(message)  → receive signature (in browser)
   *   3. POST /login { walletAddress, signature, role }
   */
  async login(
    req: Request<unknown, unknown, LoginBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    const { walletAddress, signature, role, orgId, ttlSeconds } = req.body;

    // Input validation
    if (!walletAddress || !WALLET_REGEX.test(walletAddress)) {
      res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Valid walletAddress is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!signature || typeof signature !== 'string') {
      res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'signature is required — call GET /challenge first',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!role || !VALID_ROLES.includes(role)) {
      res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: `role must be one of: ${VALID_ROLES.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const wallet = walletAddress.toLowerCase();

    // Retrieve the challenge nonce we issued for this wallet 
    const nonce = this.challengeStore.get(wallet);
    if (!nonce) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'No active challenge for this wallet. Call GET /challenge first.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify the signature — recover signer address from signed message
    try {
      const message = buildChallengeMessage(wallet, nonce);
      const recovered = verifyMessage(message, signature).toLowerCase();

      if (recovered !== wallet) {
        incrementLoginError();
        Logger.warn('Signature verification failed', { walletAddress: wallet });
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Signature verification failed',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    } catch {
      incrementLoginError();
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid signature format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Consume nonce immediately (replay protection)
    this.challengeStore.delete(wallet);

    // Issue session
    try {
      const result = await this.sessionService.login(wallet, role, orgId, ttlSeconds);
      Logger.info('Login successful', { walletAddress: wallet, role });
      res.status(201).json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      incrementLoginError();
      Logger.error('Login failed', err);
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: err instanceof Error ? err.message : 'Login failed',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * POST /session/refresh
   * Issues a new session in exchange for a valid current one.
   */
  async refresh(
    req: Request,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    const session = req.userSession!;
    try {
      const result = await this.sessionService.refresh(session.sessionId);
      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      Logger.error('Session refresh failed', err);
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: err instanceof Error ? err.message : 'Refresh failed',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * POST /session/revoke
   * Permanently invalidates the current session.
   */
  async revoke(
    req: Request,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    const session = req.userSession!;
    await this.sessionService.revoke(session.sessionId);
    res.json({
      success: true,
      data: { revoked: true },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * GET /session
   * Returns the currently resolved session (identity, role, expiry).
   */
  getSession(
    req: Request,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): void {
    const session = req.userSession!;
    res.json({
      success: true,
      data: {
        userId: session.userId,
        walletAddress: session.walletAddress,
        role: session.role,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
      },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Builds the deterministic message a user must sign to prove wallet ownership.
 * Must be identical in the browser (SDK) and on the server (verification).
 */
export function buildChallengeMessage(wallet: string, nonce: string): string {
  return `Sign in to Agroasys\nWallet: ${wallet}\nNonce: ${nonce}`;
}
