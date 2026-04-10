/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { LegacyWalletAuthController, SessionController } from './controller';
import { createSessionMiddleware } from '../middleware/middleware';
import { SessionService } from '../core/sessionService';

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createRouter(
  sessionController: SessionController,
  sessionService: SessionService,
  options?: {
    legacyWalletController?: LegacyWalletAuthController;
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
  if (options?.legacyWalletController) {
    router.get(
      '/challenge',
      asyncHandler((req, res) =>
        options.legacyWalletController!.getChallenge(
          req as Request<unknown, unknown, unknown, { wallet?: string }>,
          res,
        ),
      ),
    );

    // Step 2 of login: browser submits wallet + signature.
    router.post(
      '/login',
      asyncHandler((req, res) =>
        options.legacyWalletController!.login(
          req as Request<
            unknown,
            unknown,
            {
              walletAddress?: string;
              signature?: string;
              role?: import('../types').UserRole;
              orgId?: string;
              ttlSeconds?: number;
            }
          >,
          res,
        ),
      ),
    );
  }

  if (options?.trustedSessionExchangeMiddleware) {
    router.post(
      '/session/exchange/agroasys',
      options.trustedSessionExchangeMiddleware,
      asyncHandler((req, res) =>
        sessionController.exchangeTrustedSession(
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
        ),
      ),
    );
  }

  router.get('/session', asyncHandler(sessionMiddleware), (req, res) =>
    sessionController.getSession(req, res),
  );

  router.post(
    '/session/refresh',
    asyncHandler(sessionMiddleware),
    asyncHandler((req, res) => sessionController.refresh(req, res)),
  );

  router.post(
    '/session/revoke',
    asyncHandler(sessionMiddleware),
    asyncHandler((req, res) => sessionController.revoke(req, res)),
  );

  return router;
}
