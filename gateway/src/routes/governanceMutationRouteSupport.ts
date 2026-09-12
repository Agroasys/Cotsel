/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response } from 'express';
import { GatewayConfig } from '../config/env';
import type {
  GovernanceActionPrepared,
  GovernanceBroadcastConfirmed,
} from '../core/governanceMutationTypes';
import { GatewayError } from '../errors';
import {
  buildGatewayPrincipal,
  requireAuthorizedSignerBinding,
  requireSignerWalletAddress,
  resolveGatewayActorKey,
} from '../middleware/auth';
import type { GatewayPrincipal } from '../middleware/auth';
import type { AuthorizedSignerBinding } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import { successResponse } from '../responses';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export interface MutationContext {
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export type MutationRequest = Request<
  Record<string, string | string[]>,
  unknown,
  Record<string, unknown>
>;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function getMutationContext(req: MutationRequest): MutationContext {
  if (!req.gatewayPrincipal) {
    throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
  }

  if (!req.requestContext) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
  }

  if (!req.idempotencyState?.idempotencyKey) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Idempotency context was not initialized');
  }

  return {
    principal: req.gatewayPrincipal,
    requestContext: req.requestContext,
    idempotencyKey: req.idempotencyState.idempotencyKey,
  };
}

function getAuthorizedGovernanceSigner(
  req: MutationRequest,
  config: GatewayConfig,
  actionDescription: string,
): { signerWallet: string; signerBinding: AuthorizedSignerBinding } {
  if (!req.gatewayPrincipal) {
    throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
  }

  const signerWallet = requireSignerWalletAddress(
    typeof req.body?.signerWallet === 'string' ? req.body.signerWallet : null,
  );
  const signerBinding = requireAuthorizedSignerBinding(
    req.gatewayPrincipal,
    config,
    'governance',
    signerWallet,
    actionDescription,
  );

  return { signerWallet, signerBinding };
}

export function getPathParam(
  value: string | string[] | undefined,
  field: string,
): string | undefined {
  if (Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Path parameter ${field} must be a string`);
  }

  return value;
}

export async function prepareAndRespond(
  req: MutationRequest,
  res: Response,
  next: NextFunction,
  options: Pick<GovernanceDirectSignRouterOptions, 'authSessionClient' | 'config'>,
  actionFactory: (
    signerWallet: string,
    signerBinding: AuthorizedSignerBinding,
  ) => Promise<GovernanceActionPrepared>,
): Promise<void> {
  try {
    const { authSessionClient, config } = options;
    const { signerWallet, signerBinding } = getAuthorizedGovernanceSigner(
      req,
      config,
      'Preparing privileged governance approval',
    );
    const prepared = await actionFactory(signerWallet, signerBinding);
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : '';
    const refreshedSession = token
      ? await authSessionClient.resolveSession(token, req.requestContext?.requestId)
      : null;
    if (!refreshedSession) {
      throw new GatewayError(401, 'AUTH_REQUIRED', 'Session was revoked during preparation');
    }
    const refreshedPrincipal = buildGatewayPrincipal(refreshedSession, token, config);
    if (
      resolveGatewayActorKey(refreshedPrincipal.session) !==
        resolveGatewayActorKey(req.gatewayPrincipal!.session) ||
      !refreshedPrincipal.gatewayRoles.includes('operator:write') ||
      !refreshedPrincipal.operatorActionCapabilities.includes('governance:write') ||
      !refreshedPrincipal.writeEnabled
    ) {
      throw new GatewayError(403, 'FORBIDDEN', 'Governance authority changed during preparation');
    }
    const refreshedBinding = requireAuthorizedSignerBinding(
      refreshedPrincipal,
      config,
      'governance',
      signerWallet,
      'Handing off privileged governance approval',
    );
    if (refreshedBinding.bindingId !== signerBinding.bindingId) {
      throw new GatewayError(
        403,
        'SIGNER_NOT_AUTHORIZED',
        'Signer binding changed during preparation',
      );
    }
    res.status(200).json(successResponse(prepared));
  } catch (error) {
    next(error);
  }
}

export async function confirmAndRespond(
  req: MutationRequest,
  res: Response,
  next: NextFunction,
  config: GatewayConfig,
  actionFactory: (
    signerWallet: string,
    signerBinding: AuthorizedSignerBinding,
  ) => Promise<GovernanceBroadcastConfirmed>,
): Promise<void> {
  try {
    const { signerWallet, signerBinding } = getAuthorizedGovernanceSigner(
      req,
      config,
      'Confirming privileged governance broadcast',
    );
    const confirmed = await actionFactory(signerWallet, signerBinding);
    res.status(200).json(successResponse(confirmed));
  } catch (error) {
    next(error);
  }
}
