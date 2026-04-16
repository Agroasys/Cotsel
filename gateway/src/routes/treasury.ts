/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { GOVERNANCE_ACTION_STATUSES, GovernanceActionStatus } from '../core/governanceStore';
import {
  TREASURY_ACTION_CATEGORIES,
  TreasuryActionCategory,
  TreasuryReadReader,
} from '../core/treasuryReadService';
import {
  TreasuryWorkflowAuditInput,
  TreasuryWorkflowClient,
} from '../core/treasuryWorkflowService';
import { GatewayError } from '../errors';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
  requireMutationWriteAccess,
  requireWalletBoundSession,
} from '../middleware/auth';
import { successResponse } from '../responses';
import { decodeGovernanceActionCursor } from '../core/governanceStore';

export interface TreasuryRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  treasuryReadService: TreasuryReadReader;
  treasuryWorkflowService: TreasuryWorkflowClient;
}

interface TreasuryAuditPayload {
  audit?: {
    reason?: string;
    ticketRef?: string;
    metadata?: Record<string, unknown>;
  };
}

function parseEnum<T extends string>(
  raw: unknown,
  values: readonly T[],
  field: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || !values.includes(raw as T)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' is invalid`, {
      field,
      allowed: values,
    });
  }

  return raw as T;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 50;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be an integer");
  }

  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'limit' must be between 1 and 200",
    );
  }

  return limit;
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'cursor' must be a non-empty string",
    );
  }

  try {
    decodeGovernanceActionCursor(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

function parseOffset(raw: unknown): number {
  if (raw === undefined) {
    return 0;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'offset' must be a non-negative integer",
    );
  }

  const offset = Number.parseInt(raw, 10);
  if (offset < 0) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'offset' must be a non-negative integer",
    );
  }

  return offset;
}

function parsePositiveInt(raw: unknown, field: string): number {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
    }

    return raw;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }

  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }

  return value;
}

function parseObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an object`);
  }

  return raw as Record<string, unknown>;
}

function parseOptionalRecord(raw: unknown, field: string): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseObject(raw, field);
}

function parseRequiredString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is required`);
  }

  return raw.trim();
}

function parseOptionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a string`);
  }

  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseAudit(raw: unknown): TreasuryWorkflowAuditInput {
  const record = parseObject(raw, 'audit');
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const ticketRef = typeof record.ticketRef === 'string' ? record.ticketRef.trim() : '';

  if (reason.length < 8 || reason.length > 2000) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'audit.reason must be between 8 and 2000 characters',
    );
  }

  if (ticketRef.length < 2 || ticketRef.length > 128) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'audit.ticketRef must be between 2 and 128 characters',
    );
  }

  return {
    reason,
    ticketRef,
    metadata: parseOptionalRecord(record.metadata, 'audit.metadata'),
  };
}

export function createTreasuryRouter(options: TreasuryRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/treasury', async (_req, res, next) => {
    try {
      const snapshot = await options.treasuryReadService.getTreasurySnapshot();
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/actions', async (req, res, next) => {
    try {
      const result = await options.treasuryReadService.listTreasuryActions({
        category: parseEnum<TreasuryActionCategory>(
          req.query.category,
          TREASURY_ACTION_CATEGORIES,
          'category',
        ),
        status: parseEnum<GovernanceActionStatus>(
          req.query.status,
          GOVERNANCE_ACTION_STATUSES,
          'status',
        ),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor),
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/accounting-periods', async (req, res, next) => {
    try {
      const result = await options.treasuryWorkflowService.listAccountingPeriods({
        status:
          typeof req.query.status === 'string' && req.query.status.trim() !== ''
            ? req.query.status
            : undefined,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
        requestContext: req.requestContext,
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/sweep-batches', async (req, res, next) => {
    try {
      const result = await options.treasuryWorkflowService.listSweepBatches({
        accountingPeriodId:
          req.query.accountingPeriodId === undefined
            ? undefined
            : parsePositiveInt(req.query.accountingPeriodId, 'accountingPeriodId'),
        status:
          typeof req.query.status === 'string' && req.query.status.trim() !== ''
            ? req.query.status
            : undefined,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
        requestContext: req.requestContext,
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/sweep-batches/:batchId', async (req, res, next) => {
    try {
      const result = await options.treasuryWorkflowService.getSweepBatch(
        parsePositiveInt(req.params.batchId, 'batchId'),
        req.requestContext,
      );

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/entries/accounting', async (req, res, next) => {
    try {
      const result = await options.treasuryWorkflowService.listEntryAccounting({
        accountingState:
          typeof req.query.accountingState === 'string' && req.query.accountingState.trim() !== ''
            ? req.query.accountingState
            : undefined,
        accountingPeriodId:
          req.query.accountingPeriodId === undefined
            ? undefined
            : parsePositiveInt(req.query.accountingPeriodId, 'accountingPeriodId'),
        sweepBatchId:
          req.query.sweepBatchId === undefined
            ? undefined
            : parsePositiveInt(req.query.sweepBatchId, 'sweepBatchId'),
        tradeId:
          typeof req.query.tradeId === 'string' && req.query.tradeId.trim() !== ''
            ? req.query.tradeId
            : undefined,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
        requestContext: req.requestContext,
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/entries/:entryId/accounting', async (req, res, next) => {
    try {
      const result = await options.treasuryWorkflowService.getEntryAccounting(
        parsePositiveInt(req.params.entryId, 'entryId'),
        req.requestContext,
      );

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  const requireTreasuryWrite = requireMutationWriteAccess();
  const assertWalletBoundTreasurySigner = (req: Request, actionDescription: string) => {
    if (!req.gatewayPrincipal) {
      throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }

    requireWalletBoundSession(req.gatewayPrincipal, actionDescription);
  };

  router.post('/treasury/accounting-periods', requireTreasuryWrite, async (req, res, next) => {
    try {
      const body = parseObject(req.body, 'body') as TreasuryAuditPayload & Record<string, unknown>;
      const result = await options.treasuryWorkflowService.createAccountingPeriod(
        {
          periodKey: parseRequiredString(body.periodKey, 'periodKey'),
          startsAt: parseRequiredString(body.startsAt, 'startsAt'),
          endsAt: parseRequiredString(body.endsAt, 'endsAt'),
        },
        {
          requestContext: req.requestContext,
          route: req.originalUrl || req.path,
          method: req.method,
          session: req.gatewayPrincipal!.session,
          audit: parseAudit(body.audit),
        },
      );

      res.status(201).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/treasury/accounting-periods/:periodId/request-close',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.requestAccountingPeriodClose(
          parsePositiveInt(req.params.periodId, 'periodId'),
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/treasury/accounting-periods/:periodId/close',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.closeAccountingPeriod(
          parsePositiveInt(req.params.periodId, 'periodId'),
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/treasury/sweep-batches', requireTreasuryWrite, async (req, res, next) => {
    try {
      const body = parseObject(req.body, 'body') as TreasuryAuditPayload & Record<string, unknown>;
      const result = await options.treasuryWorkflowService.createSweepBatch(
        {
          batchKey: parseRequiredString(body.batchKey, 'batchKey'),
          accountingPeriodId: parsePositiveInt(body.accountingPeriodId, 'accountingPeriodId'),
          assetSymbol: parseRequiredString(body.assetSymbol, 'assetSymbol'),
          expectedTotalRaw: parseRequiredString(body.expectedTotalRaw, 'expectedTotalRaw'),
          payoutReceiverAddress: parseOptionalString(
            body.payoutReceiverAddress,
            'payoutReceiverAddress',
          ),
        },
        {
          requestContext: req.requestContext,
          route: req.originalUrl || req.path,
          method: req.method,
          session: req.gatewayPrincipal!.session,
          audit: parseAudit(body.audit),
        },
      );

      res.status(201).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/treasury/sweep-batches/:batchId/entries',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.addSweepBatchEntry(
          parsePositiveInt(req.params.batchId, 'batchId'),
          {
            ledgerEntryId: parsePositiveInt(body.ledgerEntryId, 'ledgerEntryId'),
            entryAmountRaw: parseOptionalString(body.entryAmountRaw, 'entryAmountRaw'),
          },
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(201).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/treasury/sweep-batches/:batchId/request-approval',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.requestSweepBatchApproval(
          parsePositiveInt(req.params.batchId, 'batchId'),
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/treasury/sweep-batches/:batchId/approve',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        assertWalletBoundTreasurySigner(req, 'Approving treasury sweep batch');
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.approveSweepBatch(
          parsePositiveInt(req.params.batchId, 'batchId'),
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/treasury/sweep-batches/:batchId/match-execution',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        assertWalletBoundTreasurySigner(req, 'Matching treasury sweep execution evidence');
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.markSweepBatchExecuted(
          parsePositiveInt(req.params.batchId, 'batchId'),
          {
            matchedSweepTxHash: parseRequiredString(body.matchedSweepTxHash, 'matchedSweepTxHash'),
          },
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  const recordExternalHandoff = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseObject(req.body, 'body') as TreasuryAuditPayload & Record<string, unknown>;
      const result = await options.treasuryWorkflowService.recordPartnerHandoff(
        parsePositiveInt(req.params.batchId, 'batchId'),
        {
          partnerName: parseRequiredString(body.partnerName, 'partnerName'),
          partnerReference: parseRequiredString(body.partnerReference, 'partnerReference'),
          handoffStatus: parseRequiredString(body.handoffStatus, 'handoffStatus'),
          evidenceReference: parseOptionalString(body.evidenceReference, 'evidenceReference'),
          metadata: parseOptionalRecord(body.metadata, 'metadata'),
        },
        {
          requestContext: req.requestContext,
          route: req.originalUrl || req.path,
          method: req.method,
          session: req.gatewayPrincipal!.session,
          audit: parseAudit(body.audit),
        },
      );

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  router.post(
    '/treasury/sweep-batches/:batchId/external-handoff',
    requireTreasuryWrite,
    recordExternalHandoff,
  );

  router.post(
    '/treasury/sweep-batches/:batchId/partner-handoff',
    requireTreasuryWrite,
    recordExternalHandoff,
  );

  router.post(
    '/treasury/sweep-batches/:batchId/close',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        assertWalletBoundTreasurySigner(req, 'Closing treasury sweep batch');
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.closeSweepBatch(
          parsePositiveInt(req.params.batchId, 'batchId'),
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/treasury/entries/:entryId/realizations',
    requireTreasuryWrite,
    async (req, res, next) => {
      try {
        const body = parseObject(req.body, 'body') as TreasuryAuditPayload &
          Record<string, unknown>;
        const result = await options.treasuryWorkflowService.createEntryRealization(
          parsePositiveInt(req.params.entryId, 'entryId'),
          {
            accountingPeriodId: parsePositiveInt(body.accountingPeriodId, 'accountingPeriodId'),
            sweepBatchId:
              body.sweepBatchId === undefined || body.sweepBatchId === null
                ? undefined
                : parsePositiveInt(body.sweepBatchId, 'sweepBatchId'),
            partnerHandoffId:
              body.partnerHandoffId === undefined || body.partnerHandoffId === null
                ? undefined
                : parsePositiveInt(body.partnerHandoffId, 'partnerHandoffId'),
            note: parseOptionalString(body.note, 'note'),
          },
          {
            requestContext: req.requestContext,
            route: req.originalUrl || req.path,
            method: req.method,
            session: req.gatewayPrincipal!.session,
            audit: parseAudit(body.audit),
          },
        );

        res.status(201).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
