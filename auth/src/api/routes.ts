/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthController } from './controller';
import { createSessionMiddleware } from '../middleware/middleware';
import { SessionService } from '../core/sessionService';

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createRouter(
  controller: AuthController,
  sessionService: SessionService,
  options?: {
    trustedSessionExchangeMiddleware?: RequestHandler;
  },
): Router {
  const router = Router();
  const sessionMiddleware = createSessionMiddleware((id) => sessionService.resolve(id));

  router.get('/health', (_req, res) => {
    res.json({
      success: true,
      service: 'auth',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', (_req, res) => {
    res.json({
      success: true,
      service: 'auth',
      ready: true,
      timestamp: new Date().toISOString(),
    });
  });

  //  Public endpoints

  // Step 1 of login: browser requests a nonce to sign.
  router.get(
    '/challenge',
    asyncHandler((req, res) => controller.getChallenge(req as Request<unknown, unknown, unknown, { wallet?: string }>, res)),
  );

  // Step 2 of login: browser submits wallet + signature.
  router.post(
    '/login',
    asyncHandler((req, res) => controller.login(req as Request<unknown, unknown, { walletAddress?: string; signature?: string; role?: import('../types').UserRole; orgId?: string; ttlSeconds?: number }>, res)),
  );

  if (options?.trustedSessionExchangeMiddleware) {
    router.post(
      '/session/exchange/agroasys',
      options.trustedSessionExchangeMiddleware,
      asyncHandler((req, res) => controller.exchangeTrustedSession(
        req as Request<
          unknown,
          unknown,
          {
            accountId?: string;
            role?: import('../types').UserRole;
            orgId?: string | null;
            email?: string | null;
            walletAddress?: string | null;
            ttlSeconds?: number;
          }
        >,
        res,
      )),
    );
  }

  router.get(
    '/session',
    asyncHandler(sessionMiddleware),
    (req, res) => controller.getSession(req, res),
  );

  router.post(
    '/session/refresh',
    asyncHandler(sessionMiddleware),
    asyncHandler((req, res) => controller.refresh(req, res)),
  );

  router.post(
    '/session/revoke',
    asyncHandler(sessionMiddleware),
    asyncHandler((req, res) => controller.revoke(req, res)),
  );

  return router;
}
