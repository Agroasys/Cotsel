/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response } from 'express';
import { GatewayConfig } from '../config/env';
import type { SignerAuthorization } from '../core/authSessionClient';
import type {
  GovernanceActionPrepared,
  GovernanceBroadcastConfirmed,
} from '../core/governanceMutationService';
import { GatewayError } from '../errors';
import { requireAuthorizedSignerBinding, requireSignerWalletAddress } from '../middleware/auth';
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import { successResponse } from '../responses';

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
): { signerWallet: string; signerBinding: SignerAuthorization } {
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

function isAllowedHumanGovernanceMutationPath(path: string): boolean {
  return path.endsWith('/prepare') || /^\/actions\/[^/]+\/confirm$/.test(path);
}

export function requireDirectSignGovernancePath(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.method === 'POST' && !isAllowedHumanGovernanceMutationPath(req.path)) {
    next(
      new GatewayError(
        409,
        'CONFLICT',
        'Human governance queue routes are retired; use the corresponding /prepare endpoint and then /governance/actions/:actionId/confirm',
        {
          reason: 'direct_sign_required',
          route: req.path,
        },
      ),
    );
    return;
  }

  next();
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
  config: GatewayConfig,
  actionFactory: (
    signerWallet: string,
    signerBinding: SignerAuthorization,
  ) => Promise<GovernanceActionPrepared>,
): Promise<void> {
  try {
    const { signerWallet, signerBinding } = getAuthorizedGovernanceSigner(
      req,
      config,
      'Preparing privileged governance approval',
    );
    const prepared = await actionFactory(signerWallet, signerBinding);
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
    signerBinding: SignerAuthorization,
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
