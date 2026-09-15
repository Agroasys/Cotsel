/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request, Response } from 'express';
import { HttpError, requireObject, requireString, success } from '@agroasys/shared-http';
import type { AdminService } from '../core/adminService';
import {
  type ApiErrorResponse,
  type ApiSuccessResponse,
  OPERATOR_SIGNER_ACTION_CLASSES,
  type OperatorSignerActionClass,
} from '../types';
import { assertWalletAddress, handleControllerError } from './controllerSupport';

interface ListSignerQuery {
  limit?: string;
  accountId?: string;
  active?: string;
}

interface ProposeSignerBody {
  accountId?: string;
  walletAddress?: string;
  actionClass?: OperatorSignerActionClass;
  environment?: string;
  custodianName?: string;
  approvalTicket?: string;
  notes?: string | null;
  reason?: string;
}

interface BindingActionBody {
  bindingId?: string;
  evidenceDigest?: string;
  reason?: string;
}

function actorFromRequest(req: Request) {
  const apiKeyId = req.serviceAuth?.apiKeyId;
  const humanPrincipalId = req.serviceAuth?.humanPrincipalId;
  if (!apiKeyId || !humanPrincipalId) {
    throw new HttpError(401, 'Unauthorized', 'Missing authenticated admin-control identity');
  }
  return { type: 'service_auth' as const, id: apiKeyId, humanPrincipalId };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'BadRequest', 'limit must be an integer');
  }
  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > 200) {
    throw new HttpError(400, 'BadRequest', 'limit must be between 1 and 200');
  }
  return limit;
}

function optionalAccountId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'BadRequest', 'accountId must be a non-empty string');
  }
  return value.trim();
}

function optionalActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, 'BadRequest', 'active must be true or false');
}

function requireActionClass(value: unknown): OperatorSignerActionClass {
  const actionClass = requireString(value, 'actionClass') as OperatorSignerActionClass;
  if (!OPERATOR_SIGNER_ACTION_CLASSES.includes(actionClass)) {
    throw new HttpError(
      400,
      'BadRequest',
      `actionClass must be one of: ${OPERATOR_SIGNER_ACTION_CLASSES.join(', ')}`,
    );
  }
  return actionClass;
}

function statusForError(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('not found')) return 404;
  if (message.includes('not pending') || message.includes('conflict')) return 409;
  if (message.includes('cannot approve')) return 403;
  return 400;
}

function fail(
  res: Response<ApiSuccessResponse | ApiErrorResponse>,
  error: unknown,
  code: string,
  message: string,
): void {
  handleControllerError(res, error, code, statusForError(error), message);
}

export class AdminSignerController {
  constructor(private readonly adminService: AdminService) {}

  async list(
    req: Request<Record<string, never>, unknown, unknown, ListSignerQuery>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const items = await this.adminService.listSignerBindings({
        accountId: optionalAccountId(req.query.accountId),
        active: optionalActive(req.query.active),
        limit: parseLimit(req.query.limit),
      });
      res.json(success({ items, generatedAt: new Date().toISOString() }));
    } catch (error) {
      fail(res, error, 'SignerListFailed', 'Signer register list failed');
    }
  }

  async propose(
    req: Request<Record<string, never>, unknown, ProposeSignerBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as ProposeSignerBody;
      const binding = await this.adminService.proposeSigner({
        accountId: requireString(body.accountId, 'accountId'),
        walletAddress: assertWalletAddress(
          requireString(body.walletAddress, 'walletAddress'),
          'walletAddress',
        ),
        actionClass: requireActionClass(body.actionClass),
        environment: requireString(body.environment, 'environment'),
        custodianName: requireString(body.custodianName, 'custodianName'),
        approvalTicket: requireString(body.approvalTicket, 'approvalTicket'),
        notes: body.notes?.trim() || null,
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      res.status(201).json(success(binding));
    } catch (error) {
      fail(res, error, 'SignerProposalFailed', 'Signer proposal failed');
    }
  }

  async approve(
    req: Request<Record<string, never>, unknown, BindingActionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as BindingActionBody;
      const binding = await this.adminService.approveSigner({
        bindingId: requireString(body.bindingId, 'bindingId'),
        evidenceDigest: requireString(body.evidenceDigest, 'evidenceDigest'),
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      res.json(success(binding));
    } catch (error) {
      fail(res, error, 'SignerApprovalFailed', 'Signer approval failed');
    }
  }

  async revoke(
    req: Request<Record<string, never>, unknown, BindingActionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as BindingActionBody;
      const binding = await this.adminService.revokeSigner({
        bindingId: requireString(body.bindingId, 'bindingId'),
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      if (!binding) throw new HttpError(404, 'SignerBindingNotFound', 'No open binding found');
      res.json(success(binding));
    } catch (error) {
      fail(res, error, 'SignerRevokeFailed', 'Signer revocation failed');
    }
  }
}
