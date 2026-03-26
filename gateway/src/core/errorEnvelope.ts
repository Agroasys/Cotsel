/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RequestContext } from '../middleware/requestContext';
import { GatewayError, type GatewayErrorCode } from '../errors';

export type GatewayFailureClass =
  | 'client_contract'
  | 'upstream_business'
  | 'infrastructure'
  | 'unexpected';

export interface GatewayErrorEnvelopeV1 {
  statusCode: number;
  code: GatewayErrorCode;
  message: string;
  requestId?: string;
  traceId?: string;
  details?: Record<string, unknown>;
  failureClass: GatewayFailureClass;
  retryable: boolean;
  replayable: boolean;
}

function classifyGatewayErrorCode(error: GatewayError): GatewayFailureClass {
  if (error.code === 'UPSTREAM_UNAVAILABLE' || error.statusCode >= 500) {
    return 'infrastructure';
  }

  if (
    error.code === 'AUTH_REQUIRED'
    || error.code === 'FORBIDDEN'
    || error.code === 'VALIDATION_ERROR'
    || error.code === 'NOT_FOUND'
  ) {
    return 'client_contract';
  }

  return 'upstream_business';
}

export function createGatewayErrorEnvelope(
  error: unknown,
  requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>,
): GatewayErrorEnvelopeV1 {
  if (error instanceof GatewayError) {
    const failureClass = classifyGatewayErrorCode(error);
    const retryable = failureClass === 'infrastructure';
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      requestId: requestContext?.requestId,
      traceId: requestContext?.correlationId,
      ...(error.details ? { details: error.details } : {}),
      failureClass,
      retryable,
      replayable: retryable,
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    requestId: requestContext?.requestId,
    traceId: requestContext?.correlationId,
    details: {
      reason: error instanceof Error ? error.message : String(error),
    },
    failureClass: 'unexpected',
    retryable: true,
    replayable: true,
  };
}

