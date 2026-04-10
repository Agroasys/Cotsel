import { RequestHandler, Router } from 'express';
import { RicardianController } from './controller';

export interface RicardianRouterOptions {
  authMiddleware?: RequestHandler;
  rateLimitMiddleware?: RequestHandler;
  readinessCheck?: () => Promise<void>;
}

export function createRouter(
  controller: RicardianController,
  options: RicardianRouterOptions = {},
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      service: 'ricardian',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (_req, res) => {
    try {
      if (options.readinessCheck) {
        await options.readinessCheck();
      }

      res.status(200).json({
        success: true,
        service: 'ricardian',
        ready: true,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        success: false,
        service: 'ricardian',
        ready: false,
        error: 'Dependencies not ready',
      });
    }
  });

  const writeMiddlewares: RequestHandler[] = [
    options.authMiddleware,
    options.rateLimitMiddleware,
  ].filter(Boolean) as RequestHandler[];
  const readMiddlewares: RequestHandler[] = [
    options.authMiddleware,
    options.rateLimitMiddleware,
  ].filter(Boolean) as RequestHandler[];

  router.post('/hash', ...writeMiddlewares, controller.createHash.bind(controller));
  router.get('/hash/:hash', ...readMiddlewares, controller.getHash.bind(controller));

  return router;
}
