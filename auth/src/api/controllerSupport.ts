/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Response } from 'express';
import { HttpError, failure, requireEnum, requireInteger } from '@agroasys/shared-http';
import { ApiErrorResponse, ApiSuccessResponse, UserRole } from '../types';

export const CHALLENGE_TTL_SECONDS = 300;
export const VALID_ROLES: UserRole[] = ['buyer', 'supplier', 'admin'];
export const VALID_SELF_SERVE_ROLES: UserRole[] = ['buyer', 'supplier'];

const WALLET_REGEX = /^0x[0-9a-f]{40}$/i;

export function assertWalletAddress(value: string, field: string): string {
  if (!WALLET_REGEX.test(value)) {
    throw new HttpError(400, 'BadRequest', `${field} must be a valid 0x wallet address`);
  }

  return value.toLowerCase();
}

export function parseOptionalSessionTtl(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireInteger(value, 'ttlSeconds');
}

export function requireAuthRole(value: unknown): UserRole {
  return requireEnum(value, VALID_ROLES, 'role');
}

export function requireSelfServeRole(value: unknown): UserRole {
  return requireEnum(value, VALID_SELF_SERVE_ROLES, 'role');
}

export function handleControllerError(
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

  res
    .status(defaultStatusCode)
    .json(failure(defaultCode, error instanceof Error ? error.message : defaultMessage));
}
