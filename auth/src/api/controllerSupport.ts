/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Response } from 'express';
import {
  HttpError,
  failure,
  isCallerFacingError,
  requireEnum,
  requireInteger,
  sendInternalFailure,
} from '@agroasys/shared-http';
import { Logger } from '../utils/logger';
import { ApiErrorResponse, ApiSuccessResponse, UserRole } from '../types';

export const VALID_ROLES: UserRole[] = ['buyer', 'supplier', 'admin'];

const WALLET_REGEX = /^0x[0-9a-f]{40}$/i;

export function assertWalletAddress(value: string, field: string): string {
  if (!WALLET_REGEX.test(value)) {
    throw new HttpError(400, 'BadRequest', `${field} must be a valid 0x wallet address`);
  }

  return value.toLowerCase();
}

export function parseOptionalSessionTtl(value: unknown, maxSeconds: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const ttlSeconds = requireInteger(value, 'ttlSeconds');
  if (ttlSeconds <= 0 || ttlSeconds > maxSeconds) {
    throw new HttpError(
      400,
      'BadRequest',
      `ttlSeconds must be an integer between 1 and ${maxSeconds}`,
    );
  }
  return ttlSeconds;
}

export function requireAuthRole(value: unknown): UserRole {
  return requireEnum(value, VALID_ROLES, 'role');
}

/**
 * WP-10 I-06. Refusals keep their code and message. Driver, network and other
 * internal failures are answered with a stable code and a correlation ID, and
 * the raw error is only logged.
 */
export function handleControllerError(
  req: Pick<Request, 'headers'>,
  res: Response<ApiSuccessResponse | ApiErrorResponse>,
  error: unknown,
  defaultCode: string,
  defaultStatusCode: number,
  defaultMessage: string,
): void {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json(failure(error.code, error.message));
    return;
  }

  if (isCallerFacingError(error)) {
    res.status(defaultStatusCode).json(failure(defaultCode, error.message || defaultMessage));
    return;
  }

  sendInternalFailure(req, res, error, {
    log: (correlationId, cause) =>
      Logger.error('Auth request failed', {
        correlationId,
        operation: defaultCode,
        errorName: cause instanceof Error ? cause.name : typeof cause,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
