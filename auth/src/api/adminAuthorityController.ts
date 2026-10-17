/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request, Response } from 'express';
import {
  HttpError,
  optionalNullableString,
  requireObject,
  requireString,
  success,
} from '@agroasys/shared-http';
import type { AdminService } from '../core/adminService';
import type {
  AdminAuthorityChangeKind,
  AdminAuthorityChangeRecord,
  ApiErrorResponse,
  ApiSuccessResponse,
  UserRole,
} from '../types';
import { handleControllerError } from './controllerSupport';

interface ListAuthorityQuery {
  limit?: string;
  accountId?: string;
  state?: string;
}

export interface ProposeAuthorityChangeBody {
  accountId?: string;
  change?: AdminAuthorityChangeKind;
  environment?: string;
  orgId?: string | null;
  expiresAt?: string | null;
  resultingRole?: UserRole | null;
  approvalTicket?: string;
  reason?: string;
}

export interface DecideAuthorityChangeBody {
  changeId?: string;
  evidenceDigest?: string;
  reason?: string;
}

const CHANGE_STATES: AdminAuthorityChangeRecord['state'][] = ['pending', 'applied', 'cancelled'];

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

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'BadRequest', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalState(value: unknown): AdminAuthorityChangeRecord['state'] | undefined {
  const state = optionalQueryString(value, 'state');
  if (
    state !== undefined &&
    !CHANGE_STATES.includes(state as AdminAuthorityChangeRecord['state'])
  ) {
    throw new HttpError(400, 'BadRequest', `state must be one of: ${CHANGE_STATES.join(', ')}`);
  }
  return state as AdminAuthorityChangeRecord['state'] | undefined;
}

function statusForError(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('not found')) return 404;
  if (message.includes('not pending') || message.includes('conflict')) return 409;
  if (message.includes('cannot approve') || message.includes('cannot be made in')) return 403;
  return 400;
}

function fail(
  req: Pick<Request, 'headers'>,
  res: Response<ApiSuccessResponse | ApiErrorResponse>,
  error: unknown,
  code: string,
  message: string,
): void {
  handleControllerError(req, res, error, code, statusForError(error), message);
}

/**
 * Two-person durable administrator authority. A grant or revocation is proposed
 * by one human principal and applied only when a different principal approves
 * its evidence digest.
 */
export class AdminAuthorityController {
  constructor(private readonly adminService: AdminService) {}

  async list(
    req: Request<Record<string, never>, unknown, unknown, ListAuthorityQuery>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const items = await this.adminService.listAuthorityChanges({
        accountId: optionalQueryString(req.query.accountId, 'accountId'),
        state: optionalState(req.query.state),
        limit: parseLimit(req.query.limit),
      });
      res.json(success({ items, generatedAt: new Date().toISOString() }));
    } catch (error) {
      fail(req, res, error, 'AuthorityChangeListFailed', 'Admin authority change list failed');
    }
  }

  async propose(
    req: Request<Record<string, never>, unknown, ProposeAuthorityChangeBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as ProposeAuthorityChangeBody;
      const change = requireString(body.change, 'change');
      if (change !== 'grant' && change !== 'revoke') {
        throw new HttpError(400, 'BadRequest', 'change must be grant or revoke');
      }
      const record = await this.adminService.proposeAuthorityChange({
        accountId: requireString(body.accountId, 'accountId'),
        change,
        environment: requireString(body.environment, 'environment'),
        orgId: optionalNullableString(body.orgId, 'orgId') ?? null,
        expiresAt: optionalNullableString(body.expiresAt, 'expiresAt') ?? null,
        resultingRole: (optionalNullableString(body.resultingRole, 'resultingRole') ??
          null) as UserRole | null,
        approvalTicket: requireString(body.approvalTicket, 'approvalTicket'),
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      res.status(201).json(success(record));
    } catch (error) {
      fail(req, res, error, 'AuthorityChangeProposalFailed', 'Admin authority proposal failed');
    }
  }

  async approve(
    req: Request<Record<string, never>, unknown, DecideAuthorityChangeBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as DecideAuthorityChangeBody;
      const record = await this.adminService.approveAuthorityChange({
        changeId: requireString(body.changeId, 'changeId'),
        evidenceDigest: requireString(body.evidenceDigest, 'evidenceDigest'),
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      res.json(success(record));
    } catch (error) {
      fail(req, res, error, 'AuthorityChangeApprovalFailed', 'Admin authority approval failed');
    }
  }

  async cancel(
    req: Request<Record<string, never>, unknown, DecideAuthorityChangeBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as DecideAuthorityChangeBody;
      const record = await this.adminService.cancelAuthorityChange({
        changeId: requireString(body.changeId, 'changeId'),
        actor: actorFromRequest(req),
        reason: requireString(body.reason, 'reason'),
      });
      res.json(success(record));
    } catch (error) {
      fail(req, res, error, 'AuthorityChangeCancelFailed', 'Admin authority cancellation failed');
    }
  }
}
