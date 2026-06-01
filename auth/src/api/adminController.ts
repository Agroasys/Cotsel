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
import {
  ApiErrorResponse,
  ApiSuccessResponse,
  OPERATOR_CAPABILITIES,
  OPERATOR_SIGNER_ACTION_CLASSES,
  BreakGlassReviewStatus,
  OperatorCapability,
  OperatorSignerActionClass,
  UserProfile,
  UserRole,
} from '../types';
import { assertWalletAddress, handleControllerError, requireAuthRole } from './controllerSupport';

const VALID_BREAK_GLASS_BASE_ROLES: Exclude<UserRole, 'admin'>[] = ['buyer', 'supplier', 'oracle'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProvisionBody {
  accountId?: string;
  role?: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  capabilities?: OperatorCapability[];
  capabilityTicketRef?: string | null;
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

interface SignerBindingBody {
  accountId?: string;
  walletAddress?: string | null;
  actionClass?: OperatorSignerActionClass;
  environment?: string;
  ticketRef?: string | null;
  notes?: string | null;
  reason?: string;
}

interface ListQuery {
  limit?: string;
  accountId?: string;
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

function requireWallet(value: string | null | undefined): string {
  const walletAddress = optionalWallet(value);
  if (!walletAddress) {
    throw new HttpError(400, 'BadRequest', 'walletAddress is required');
  }
  return walletAddress;
}

function optionalOrgId(value: string | null | undefined): string | null {
  return optionalNullableString(value, 'orgId') ?? null;
}

function requireReason(value: unknown): string {
  return requireString(value, 'reason');
}

function optionalTicketRef(value: string | null | undefined): string | null {
  return optionalNullableString(value, 'ticketRef') ?? null;
}

function optionalNotes(value: string | null | undefined): string | null {
  return optionalNullableString(value, 'notes') ?? null;
}

function requireEnvironment(value: unknown): string {
  const environment = requireString(value, 'environment').trim();
  if (!environment) {
    throw new HttpError(400, 'BadRequest', 'environment is required');
  }
  return environment;
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

function optionalCapabilities(value: unknown): OperatorCapability[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'BadRequest', 'capabilities must be an array');
  }

  const invalid = value.filter(
    (capability): capability is unknown =>
      typeof capability !== 'string' ||
      !OPERATOR_CAPABILITIES.includes(capability as OperatorCapability),
  );
  if (invalid.length > 0) {
    throw new HttpError(
      400,
      'BadRequest',
      `capabilities must only contain: ${OPERATOR_CAPABILITIES.join(', ')}`,
    );
  }

  return [...new Set(value)] as OperatorCapability[];
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return 100;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'BadRequest', 'limit must be an integer');
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(400, 'BadRequest', 'limit must be between 1 and 200');
  }
  return limit;
}

function optionalAccountId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'BadRequest', 'accountId must be a non-empty string');
  }
  return value.trim();
}

function profilePayload(profile: UserProfile) {
  const breakGlassActive =
    profile.breakGlassRole === 'admin' &&
    profile.breakGlassExpiresAt !== null &&
    profile.breakGlassExpiresAt.getTime() > Date.now() &&
    profile.breakGlassRevokedAt === null;
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
      active: breakGlassActive,
      role: profile.breakGlassRole,
      expiresAt: profile.breakGlassExpiresAt?.toISOString() ?? null,
      grantedAt: profile.breakGlassGrantedAt?.toISOString() ?? null,
      grantedBy: profile.breakGlassGrantedBy,
      reason: profile.breakGlassReason,
      revokedAt: profile.breakGlassRevokedAt?.toISOString() ?? null,
      revokedBy: profile.breakGlassRevokedBy,
      reviewedAt: profile.breakGlassReviewedAt?.toISOString() ?? null,
      reviewedBy: profile.breakGlassReviewedBy,
      reviewStatus: resolveBreakGlassReviewStatus({
        active: breakGlassActive,
        role: profile.breakGlassRole,
        expiresAt: profile.breakGlassExpiresAt?.toISOString() ?? null,
        grantedAt: profile.breakGlassGrantedAt?.toISOString() ?? null,
        revokedAt: profile.breakGlassRevokedAt?.toISOString() ?? null,
        reviewedAt: profile.breakGlassReviewedAt?.toISOString() ?? null,
      }),
    },
  };
}

function resolveBreakGlassReviewStatus(input: {
  active: boolean;
  role: 'admin' | null;
  expiresAt: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  reviewedAt: string | null;
}): BreakGlassReviewStatus {
  if (input.reviewedAt) {
    return 'reviewed';
  }
  if (!input.role && !input.grantedAt && !input.expiresAt && !input.revokedAt) {
    return 'none';
  }
  if (input.revokedAt) {
    return 'revoked_unreviewed';
  }
  if (input.active) {
    return 'active_unreviewed';
  }
  return 'expired_unreviewed';
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

  async listAuthorityProfiles(
    req: Request<Record<string, never>, unknown, unknown, ListQuery>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const profiles = await this.adminService.listAuthorityProfiles({
        limit: parseLimit(req.query.limit),
      });
      res.json(
        success({
          items: profiles.map((snapshot) => ({
            ...profilePayload(snapshot.profile),
            capabilities: snapshot.capabilities,
            signerBindings: snapshot.signerBindings,
            recentAuditEvents: snapshot.recentAuditEvents,
          })),
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      handleControllerError(
        res,
        error,
        'AdminAuthorityListFailed',
        statusForAdminError(error),
        'Admin authority list failed',
      );
    }
  }

  async listAuditEvents(
    req: Request<Record<string, never>, unknown, unknown, ListQuery>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const events = await this.adminService.listAuditEvents({
        accountId: optionalAccountId(req.query.accountId),
        limit: parseLimit(req.query.limit),
      });
      res.json(
        success({
          items: events,
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      handleControllerError(
        res,
        error,
        'AdminAuditListFailed',
        statusForAdminError(error),
        'Admin audit list failed',
      );
    }
  }

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
        capabilities: optionalCapabilities(body.capabilities),
        capabilityTicketRef: optionalTicketRef(body.capabilityTicketRef),
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

  async provisionSigner(
    req: Request<Record<string, never>, unknown, SignerBindingBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as SignerBindingBody;
      const binding = await this.adminService.provisionSigner({
        accountId: requireString(body.accountId, 'accountId'),
        walletAddress: requireWallet(body.walletAddress),
        actionClass: requireActionClass(body.actionClass),
        environment: requireEnvironment(body.environment),
        ticketRef: optionalTicketRef(body.ticketRef),
        notes: optionalNotes(body.notes),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      res.status(201).json(success(binding));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'SignerProvisionFailed',
        statusForAdminError(error),
        'Signer provisioning failed',
      );
    }
  }

  async revokeSigner(
    req: Request<Record<string, never>, unknown, SignerBindingBody>,
    res: Response<ApiSuccessResponse | ApiErrorResponse>,
  ): Promise<void> {
    try {
      const body = requireObject(req.body, 'body') as SignerBindingBody;
      const binding = await this.adminService.revokeSigner({
        accountId: requireString(body.accountId, 'accountId'),
        walletAddress: requireWallet(body.walletAddress),
        actionClass: requireActionClass(body.actionClass),
        environment: requireEnvironment(body.environment),
        actor: actorFromRequest(req),
        reason: requireReason(body.reason),
      });

      if (!binding) {
        throw new HttpError(404, 'SignerBindingNotFound', 'No active signer binding found');
      }

      res.json(success(binding));
    } catch (error) {
      handleControllerError(
        res,
        error,
        'SignerRevokeFailed',
        statusForAdminError(error),
        'Signer revocation failed',
      );
    }
  }
}
