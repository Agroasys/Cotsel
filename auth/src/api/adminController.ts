/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Response } from 'express';
import {
  HttpError,
  optionalNullableString,
  requireObject,
  requireString,
  success,
} from '@agroasys/shared-http';
import { AdminService } from '../core/adminService';
import { ApiErrorResponse, ApiSuccessResponse, UserProfile, UserRole } from '../types';
import { assertWalletAddress, handleControllerError, requireAuthRole } from './controllerSupport';

const VALID_BREAK_GLASS_BASE_ROLES: Exclude<UserRole, 'admin'>[] = ['buyer', 'supplier', 'oracle'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProvisionBody {
  accountId?: string;
  role?: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  reason?: string;
}

interface BreakGlassBody {
  accountId?: string;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  reason?: string;
  ttlSeconds?: number;
  baseRole?: Exclude<UserRole, 'admin'>;
}

interface AccountActionBody {
  accountId?: string;
  reason?: string;
}

function actorFromRequest(req: Request) {
  const apiKeyId = req.serviceAuth?.apiKeyId;
  if (!apiKeyId) {
    throw new HttpError(401, 'Unauthorized', 'Missing service-auth actor context');
  }
  return { type: 'service_auth' as const, id: apiKeyId };
}

function optionalEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? null;
  if (normalized && !EMAIL_REGEX.test(normalized)) {
    throw new HttpError(400, 'BadRequest', 'email must be a valid email address');
  }
  return normalized;
}

function optionalWallet(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  return assertWalletAddress(value, 'walletAddress');
}

function optionalOrgId(value: string | null | undefined): string | null {
  return optionalNullableString(value, 'orgId') ?? null;
}

function requireReason(value: unknown): string {
  return requireString(value, 'reason');
}

function profilePayload(profile: UserProfile) {
  return {
    userId: profile.id,
    accountId: profile.accountId,
    walletAddress: profile.walletAddress,
    email: profile.email,
    role: profile.role,
    baseRole: profile.baseRole,
    orgId: profile.orgId,
    active: profile.active,
    breakGlass: {
      active:
        profile.breakGlassRole === 'admin' &&
        profile.breakGlassExpiresAt !== null &&
        profile.breakGlassExpiresAt.getTime() > Date.now() &&
        profile.breakGlassRevokedAt === null,
      role: profile.breakGlassRole,
      expiresAt: profile.breakGlassExpiresAt?.toISOString() ?? null,
      grantedAt: profile.breakGlassGrantedAt?.toISOString() ?? null,
      grantedBy: profile.breakGlassGrantedBy,
      reason: profile.breakGlassReason,
      revokedAt: profile.breakGlassRevokedAt?.toISOString() ?? null,
      revokedBy: profile.breakGlassRevokedBy,
      reviewedAt: profile.breakGlassReviewedAt?.toISOString() ?? null,
      reviewedBy: profile.breakGlassReviewedBy,
    },
  };
}

function statusForAdminError(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('not found')) return 404;
  if (message.includes('only valid for')) return 409;
  return 400;
}

export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  async provision(
    req: Request<Record<string, never>, unknown, ProvisionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as ProvisionBody;
      const accountId = requireString(body.accountId, 'accountId');
      const role = requireAuthRole(body.role);
      const profile = await this.adminService.provisionProfile({
        accountId,
        role,
        orgId: optionalOrgId(body.orgId),
        email: optionalEmail(body.email),
        walletAddress: optionalWallet(body.walletAddress),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      res.status(201).json(success(profilePayload(profile)));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'AdminProvisionFailed',
        statusForAdminError(error),
        'Admin provisioning failed',
      );
    }
  }

  async grantBreakGlass(
    req: Request<Record<string, never>, unknown, BreakGlassBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as BreakGlassBody;
      const accountId = requireString(body.accountId, 'accountId');
      if (!Number.isInteger(body.ttlSeconds)) {
        throw new HttpError(400, 'BadRequest', 'ttlSeconds must be an integer');
      }
      if (body.baseRole && !VALID_BREAK_GLASS_BASE_ROLES.includes(body.baseRole)) {
        throw new HttpError(
          400,
          'BadRequest',
          `baseRole must be one of: ${VALID_BREAK_GLASS_BASE_ROLES.join(', ')}`,
        );
      }

      const profile = await this.adminService.grantBreakGlass({
        accountId,
        orgId: optionalOrgId(body.orgId),
        email: optionalEmail(body.email),
        walletAddress: optionalWallet(body.walletAddress),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
        ttlSeconds: body.ttlSeconds!,
        baseRole: body.baseRole,
      });

      res.status(201).json(success(profilePayload(profile)));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'BreakGlassGrantFailed',
        statusForAdminError(error),
        'Break-glass grant failed',
      );
    }
  }

  async revokeBreakGlass(
    req: Request<Record<string, never>, unknown, AccountActionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as AccountActionBody;
      const profile = await this.adminService.revokeBreakGlass({
        accountId: requireString(body.accountId, 'accountId'),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      if (!profile) {
        throw new HttpError(404, 'BreakGlassNotFound', 'No break-glass grant found for account');
      }

      res.json(success(profilePayload(profile)));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'BreakGlassRevokeFailed',
        statusForAdminError(error),
        'Break-glass revoke failed',
      );
    }
  }

  async reviewBreakGlass(
    req: Request<Record<string, never>, unknown, AccountActionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as AccountActionBody;
      const profile = await this.adminService.reviewBreakGlass({
        accountId: requireString(body.accountId, 'accountId'),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      res.json(success(profilePayload(profile)));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'BreakGlassReviewFailed',
        statusForAdminError(error),
        'Break-glass review failed',
      );
    }
  }

  async deactivate(
    req: Request<Record<string, never>, unknown, AccountActionBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as AccountActionBody;
      const profile = await this.adminService.deactivateProfile({
        accountId: requireString(body.accountId, 'accountId'),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      res.json(success(profilePayload(profile)));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'ProfileDeactivateFailed',
        statusForAdminError(error),
        'Profile deactivation failed',
      );
    }
  }
}
