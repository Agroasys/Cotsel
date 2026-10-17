/**
 * SPDX-License-Identifier: Apache-2.0
 */
export type GatewayErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'WALLET_SIGNER_REQUIRED'
  | 'SIGNER_NOT_AUTHORIZED'
  | 'SIGNER_POLICY_RESTRICTED'
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
    /** Internal failure context for logs only; never serialized into a response. */
    public readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Raw failure text for `diagnostics`; it can carry URLs, queries, or provider output. */
export function diagnosticReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
