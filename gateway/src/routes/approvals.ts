/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  APPROVAL_WORKFLOW_CATEGORIES,
  ApprovalWorkflowReadService,
} from '../core/approvalWorkflowReadService';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';
import { decodeGovernanceActionCursor } from '../core/governanceStore';
import { GatewayError } from '../errors';

export interface ApprovalWorkflowRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  approvalWorkflowReadService: ApprovalWorkflowReadService;
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

function parseCategory(raw: unknown) {
  if (raw === undefined) {
    return undefined;
  }

  if (
    typeof raw !== 'string' ||
    !APPROVAL_WORKFLOW_CATEGORIES.includes(raw as (typeof APPROVAL_WORKFLOW_CATEGORIES)[number])
  ) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'category' is invalid", {
      field: 'category',
      allowed: APPROVAL_WORKFLOW_CATEGORIES,
    });
  }

  return raw as (typeof APPROVAL_WORKFLOW_CATEGORIES)[number];
}

export function createApprovalWorkflowRouter(options: ApprovalWorkflowRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/approvals', async (req, res, next) => {
    try {
      const result = await options.approvalWorkflowReadService.list({
        category: parseCategory(req.query.category),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor),
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/approvals/:approvalId', async (req, res, next) => {
    try {
      const approvalId = req.params.approvalId?.trim();
      if (!approvalId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter approvalId is required');
      }

      const workflow = await options.approvalWorkflowReadService.get(approvalId);
      if (!workflow) {
        throw new GatewayError(404, 'NOT_FOUND', 'Approval workflow not found', {
          approvalId,
        });
      }

      res.status(200).json(successResponse(workflow));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
