import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, hmacMiddleware } from '../middleware/middleware';
import { OracleController } from './controller';

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createRouter(
  controller: OracleController,
  readinessCheck?: () => Promise<void>,
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      success: true,
      service: 'oracle',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (_req, res) => {
    try {
      if (readinessCheck) {
        await readinessCheck();
      }

      res.json({
        success: true,
        service: 'oracle',
        ready: true,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        success: false,
        service: 'oracle',
        ready: false,
        error: 'Dependencies not ready',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post(
    '/release-stage1',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.releaseStage1(req, res)),
  );

  router.post(
    '/confirm-arrival',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.confirmArrival(req, res)),
  );

  router.post(
    '/finalize-trade',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.finalizeTrade(req, res)),
  );

  router.post(
    '/redrive',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.redriveTrigger(req, res)),
  );

  router.post(
    '/approve',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.approveTrigger(req, res)),
  );

  router.post(
    '/reject',
    authMiddleware,
    hmacMiddleware,
    asyncHandler((req, res) => controller.rejectTrigger(req, res)),
  );

  return router;
}
