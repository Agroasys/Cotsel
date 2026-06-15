/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { SessionController } from './controller';
import { AdminController } from './adminController';
import { createSessionMiddleware } from '../middleware/middleware';
import { SessionService } from '../core/sessionService';

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createRouter(
  sessionController: SessionController,
  sessionService: SessionService,
  options?: {
    trustedSessionExchangeMiddleware?: RequestHandler;
    adminController?: AdminController;
    adminControlMiddleware?: RequestHandler;
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

  if (options?.adminController && options.adminControlMiddleware) {
    router.get(
      '/admin/profiles',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.listAuthorityProfiles(
          req as Request<
            Record<string, never>,
            unknown,
            unknown,
            { limit?: string; accountId?: string }
          >,
          res,
        ),
      ),
    );

    router.get(
      '/admin/audit-events',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.listAuditEvents(
          req as Request<
            Record<string, never>,
            unknown,
            unknown,
            { limit?: string; accountId?: string }
          >,
          res,
        ),
      ),
    );

    router.post(
      '/admin/profiles/provision',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.provision(
          req as Request<
            Record<string, never>,
            unknown,
            {
              accountId?: string;
              role?: import('../types').UserRole;
              orgId?: string | null;
              email?: string | null;
              walletAddress?: string | null;
              capabilities?: import('../types').OperatorCapability[];
              capabilityTicketRef?: string | null;
              reason?: string;
            }
          >,
          res,
        ),
      ),
    );

    router.post(
      '/admin/profiles/deactivate',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.deactivate(
          req as Request<Record<string, never>, unknown, { accountId?: string; reason?: string }>,
          res,
        ),
      ),
    );

    router.post(
      '/admin/signers/provision',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.provisionSigner(
          req as Request<
            Record<string, never>,
            unknown,
            {
              accountId?: string;
              walletAddress?: string | null;
              actionClass?: import('../types').OperatorSignerActionClass;
              environment?: string;
              ticketRef?: string | null;
              notes?: string | null;
              reason?: string;
            }
          >,
          res,
        ),
      ),
    );

    router.post(
      '/admin/signers/revoke',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.revokeSigner(
          req as Request<
            Record<string, never>,
            unknown,
            {
              accountId?: string;
              walletAddress?: string | null;
              actionClass?: import('../types').OperatorSignerActionClass;
              environment?: string;
              reason?: string;
            }
          >,
          res,
        ),
      ),
    );

    router.post(
      '/admin/break-glass/grant',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.grantBreakGlass(
          req as Request<
            Record<string, never>,
            unknown,
            {
              accountId?: string;
              orgId?: string | null;
              email?: string | null;
              walletAddress?: string | null;
              reason?: string;
              ttlSeconds?: number;
              baseRole?: Exclude<import('../types').UserRole, 'admin'>;
            }
          >,
          res,
        ),
      ),
    );

    router.post(
      '/admin/break-glass/revoke',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.revokeBreakGlass(
          req as Request<Record<string, never>, unknown, { accountId?: string; reason?: string }>,
          res,
        ),
      ),
    );

    router.post(
      '/admin/break-glass/review',
      options.adminControlMiddleware,
      asyncHandler((req, res) =>
        options.adminController!.reviewBreakGlass(
          req as Request<Record<string, never>, unknown, { accountId?: string; reason?: string }>,
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
