/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Response, NextFunction } from 'express';
import { failure } from '@agroasys/shared-http';
import { ApiErrorResponse, UserSession } from '../types';
import { Logger } from '../utils/logger';

// Augment Express Request to carry resolved session
declare global {
  namespace Express {
    interface Request {
      userSession?: UserSession;
    }
  }
}

type ResolveFn = (sessionId: string) => Promise<UserSession | null>;

/**
 * Builds an Express middleware that resolves a Bearer session token into
 * a UserSession and attaches it to req.userSession.
 */
export function createSessionMiddleware(resolve: ResolveFn) {
  return async (
    req: Request,
    res: Response<ApiErrorResponse>,
    next: NextFunction,
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json(failure('Unauthorized', 'Missing or malformed Authorization header'));
      return;
    }

    const sessionId = authHeader.slice(7).trim();
    if (!sessionId) {
      res.status(401).json(failure('Unauthorized', 'Empty session token'));
      return;
    }

    const session = await resolve(sessionId).catch((err) => {
      Logger.error('Session resolution error', err);
      return null;
    });

    if (!session) {
      Logger.warn('Invalid or expired session', { ip: req.ip });
      res.status(401).json(failure('Unauthorized', 'Session invalid, expired, or revoked'));
      return;
    }

    req.userSession = session;
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response<ApiErrorResponse>, next: NextFunction): void => {
    const session = req.userSession;
    if (!session || !roles.includes(session.role)) {
      res.status(403).json(failure('Forbidden', `Role '${session?.role ?? 'unknown'}' is not permitted`));
      return;
    }
    next();
  };
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response<ApiErrorResponse>,
  _next: NextFunction,
): void {
  Logger.error('Unhandled error', err);
  res.status(500).json(failure('InternalServerError', 'An unexpected error occurred'));
}
