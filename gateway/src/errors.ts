/**
 * SPDX-License-Identifier: Apache-2.0
 */
export type GatewayErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'WALLET_SIGNER_REQUIRED'
  | 'SIGNER_NOT_AUTHORIZED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
