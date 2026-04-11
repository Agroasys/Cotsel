/**
 * SPDX-License-Identifier: Apache-2.0
 */
export class AgroasysSDKError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgroasysSDKError';
  }
}

export class SignatureError extends AgroasysSDKError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SIGNATURE_ERROR', context);
    this.name = 'SignatureError';
  }
}

export class ContractError extends AgroasysSDKError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONTRACT_ERROR', context);
    this.name = 'ContractError';
  }
}

export class ValidationError extends AgroasysSDKError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

export class AuthorizationError extends AgroasysSDKError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AUTHORIZATION_ERROR', context);
    this.name = 'AuthorizationError';
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
