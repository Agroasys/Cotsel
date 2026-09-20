import { RequestHandler, Router } from 'express';
import { TreasuryController } from './controller';
import type { IngestionFreshnessAssessment } from '../core/ingestionFreshness';

export interface TreasuryRouterOptions {
  authMiddleware?: RequestHandler;
  mutationAuthMiddleware?: RequestHandler;
  /**
   * Applied only to the routes that carry external provider evidence. Cotsel's
   * own service key proves an internal caller relayed the payload; this proves
   * the provider produced it.
   */
  providerCallbackMiddleware?: RequestHandler;
  readinessCheck?: () => Promise<void>;
  /**
   * WP-4 B-09 / FAIL-10. Readiness, not liveness: a treasury whose chain
   * evidence has stopped advancing is still a healthy process, and `/health`
   * keeps saying so. What it is not is safe to export, realize or close
   * against, and this is the signal that says which of the two it is.
   */
  ingestionFreshnessCheck?: () => Promise<IngestionFreshnessAssessment>;
}

function serializeIngestionFreshness(assessment: IngestionFreshnessAssessment): {
  status: string;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  lagBlocks: number | null;
  maxLagBlocks: number;
  ingestedThroughBlockNumber: number | null;
  consecutiveFailureCount: number;
  blockedReasons: string[];
} {
  return {
    status: assessment.status,
    lastSuccessAt: assessment.lastSuccessAt?.toISOString() ?? null,
    ageSeconds: assessment.ageSeconds,
    maxAgeSeconds: assessment.maxAgeSeconds,
    lagBlocks: assessment.lagBlocks,
    maxLagBlocks: assessment.maxLagBlocks,
    ingestedThroughBlockNumber: assessment.ingestedThroughBlockNumber,
    consecutiveFailureCount: assessment.consecutiveFailureCount,
    blockedReasons: assessment.blockedReasons,
  };
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

      const ingestion = options.ingestionFreshnessCheck
        ? await options.ingestionFreshnessCheck()
        : null;

      if (ingestion && ingestion.status !== 'FRESH') {
        // The blocked reasons are returned rather than summarized. An operator
        // reading a red probe needs the cause on the probe, not a pointer to a
        // log they then have to correlate by timestamp.
        res.status(503).json({
          success: false,
          service: 'treasury',
          ready: false,
          error: 'Treasury chain-evidence ingestion is not fresh',
          ingestion: serializeIngestionFreshness(ingestion),
        });
        return;
      }

      res.status(200).json({
        success: true,
        service: 'treasury',
        ready: true,
        ingestion: ingestion ? serializeIngestionFreshness(ingestion) : null,
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
  const providerCallbackMiddlewares: RequestHandler[] = [
    ...internalMutationMiddlewares,
    options.providerCallbackMiddleware,
  ].filter(Boolean) as RequestHandler[];

  router.get('/auth-check', ...protectedMiddlewares, (_req, res) => {
    res.status(200).json({
      success: true,
      service: 'treasury',
      authenticated: true,
    });
  });

  router.get(
    '/chain/canonicality-summary',
    ...protectedMiddlewares,
    controller.getChainCanonicalitySummary.bind(controller),
  );
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
    ...providerCallbackMiddlewares,
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
    '/internal/sweep-batches/:batchId/close',
    ...internalMutationMiddlewares,
    controller.closeSweepBatch.bind(controller),
  );
  router.post(
    '/internal/deposits',
    ...providerCallbackMiddlewares,
    controller.upsertDeposit.bind(controller),
  );

  return router;
}
