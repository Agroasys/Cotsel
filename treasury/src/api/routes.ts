import { RequestHandler, Router } from 'express';
import { TreasuryController } from './controller';

export interface TreasuryRouterOptions {
  authMiddleware?: RequestHandler;
  readinessCheck?: () => Promise<void>;
}

export function createRouter(controller: TreasuryController, options: TreasuryRouterOptions = {}): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ success: true, service: 'treasury', status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/ready', async (_req, res) => {
    try {
      if (options.readinessCheck) {
        await options.readinessCheck();
      }

      res.status(200).json({ success: true, service: 'treasury', ready: true, timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ success: false, service: 'treasury', ready: false, error: 'Dependencies not ready' });
    }
  });

  const protectedMiddlewares: RequestHandler[] = [options.authMiddleware].filter(Boolean) as RequestHandler[];

  router.post('/ingest', ...protectedMiddlewares, controller.ingest.bind(controller));
  router.get('/entries', ...protectedMiddlewares, controller.listEntries.bind(controller));
  router.post('/entries/:entryId/state', ...protectedMiddlewares, controller.appendState.bind(controller));
  router.post('/entries/:entryId/bank-confirmation', ...protectedMiddlewares, controller.upsertBankConfirmation.bind(controller));
  router.post('/deposits', ...protectedMiddlewares, controller.upsertDeposit.bind(controller));
  router.get('/export', ...protectedMiddlewares, controller.exportEntries.bind(controller));

  return router;
}
