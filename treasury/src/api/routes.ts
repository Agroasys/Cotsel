import { RequestHandler, Router } from 'express';
import { TreasuryController } from './controller';

export interface TreasuryRouterOptions {
  authMiddleware?: RequestHandler;
  mutationAuthMiddleware?: RequestHandler;
  readinessCheck?: () => Promise<void>;
}

export function createRouter(
  controller: TreasuryController,
  options: TreasuryRouterOptions = {},
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      service: 'treasury',
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
        service: 'treasury',
        ready: true,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        success: false,
        service: 'treasury',
        ready: false,
        error: 'Dependencies not ready',
      });
    }
  });

  const protectedMiddlewares: RequestHandler[] = [options.authMiddleware].filter(
    Boolean,
  ) as RequestHandler[];
  const internalMutationMiddlewares: RequestHandler[] = [
    options.authMiddleware,
    options.mutationAuthMiddleware,
  ].filter(Boolean) as RequestHandler[];
  const addLegacyPartnerHandoffDeprecationHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Thu, 31 Dec 2026 23:59:59 GMT');
    next();
  };

  router.get(
    '/reconciliation/control-summary',
    ...protectedMiddlewares,
    controller.getReconciliationControlSummary.bind(controller),
  );
  router.get('/entries', ...protectedMiddlewares, controller.listEntries.bind(controller));
  router.get(
    '/entries/accounting',
    ...protectedMiddlewares,
    controller.listEntryAccounting.bind(controller),
  );
  router.get(
    '/entries/:entryId/accounting',
    ...protectedMiddlewares,
    controller.getEntryAccounting.bind(controller),
  );
  router.get(
    '/entries/:entryId/partner-handoff',
    ...protectedMiddlewares,
    controller.getTreasuryPartnerHandoff.bind(controller),
  );
  router.get(
    '/accounting-periods',
    ...protectedMiddlewares,
    controller.listAccountingPeriods.bind(controller),
  );
  router.get(
    '/accounting-periods/:periodId/rollforward',
    ...protectedMiddlewares,
    controller.getAccountingPeriodRollforward.bind(controller),
  );
  router.get(
    '/accounting-periods/:periodId/close-packet',
    ...protectedMiddlewares,
    controller.getAccountingPeriodClosePacket.bind(controller),
  );
  router.get(
    '/sweep-batches',
    ...protectedMiddlewares,
    controller.listSweepBatches.bind(controller),
  );
  router.get(
    '/sweep-batches/:batchId',
    ...protectedMiddlewares,
    controller.getSweepBatch.bind(controller),
  );
  router.get(
    '/sweep-batches/:batchId/trace',
    ...protectedMiddlewares,
    controller.getSweepBatchTrace.bind(controller),
  );
  router.get('/export', ...protectedMiddlewares, controller.exportEntries.bind(controller));
  router.post(
    '/internal/ingest',
    ...internalMutationMiddlewares,
    controller.ingest.bind(controller),
  );
  router.post(
    '/internal/entries/:entryId/state',
    ...internalMutationMiddlewares,
    controller.appendState.bind(controller),
  );
  router.post(
    '/internal/entries/:entryId/realizations',
    ...internalMutationMiddlewares,
    controller.createEntryRealization.bind(controller),
  );
  router.post(
    '/internal/entries/:entryId/partner-handoff',
    ...internalMutationMiddlewares,
    controller.upsertTreasuryPartnerHandoff.bind(controller),
  );
  router.post(
    '/internal/entries/:entryId/partner-handoff/evidence',
    ...internalMutationMiddlewares,
    controller.appendTreasuryPartnerHandoffEvidence.bind(controller),
  );
  router.post(
    '/internal/entries/:entryId/bank-confirmation',
    ...internalMutationMiddlewares,
    controller.upsertBankConfirmation.bind(controller),
  );
  router.post(
    '/internal/accounting-periods',
    ...internalMutationMiddlewares,
    controller.createAccountingPeriod.bind(controller),
  );
  router.post(
    '/internal/accounting-periods/:periodId/request-close',
    ...internalMutationMiddlewares,
    controller.requestAccountingPeriodClose.bind(controller),
  );
  router.post(
    '/internal/accounting-periods/:periodId/close',
    ...internalMutationMiddlewares,
    controller.closeAccountingPeriod.bind(controller),
  );
  router.post(
    '/internal/sweep-batches',
    ...internalMutationMiddlewares,
    controller.createSweepBatch.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/entries',
    ...internalMutationMiddlewares,
    controller.addSweepBatchEntry.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/request-approval',
    ...internalMutationMiddlewares,
    controller.requestSweepBatchApproval.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/approve',
    ...internalMutationMiddlewares,
    controller.approveSweepBatch.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/match-execution',
    ...internalMutationMiddlewares,
    controller.markSweepBatchExecuted.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/external-handoff',
    ...internalMutationMiddlewares,
    controller.recordPartnerHandoff.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/partner-handoff',
    ...internalMutationMiddlewares,
    addLegacyPartnerHandoffDeprecationHeaders,
    controller.recordPartnerHandoff.bind(controller),
  );
  router.post(
    '/internal/sweep-batches/:batchId/close',
    ...internalMutationMiddlewares,
    controller.closeSweepBatch.bind(controller),
  );
  router.post(
    '/internal/deposits',
    ...internalMutationMiddlewares,
    controller.upsertDeposit.bind(controller),
  );

  return router;
}
