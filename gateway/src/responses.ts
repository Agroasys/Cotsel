/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RequestContext } from './middleware/requestContext';

export function isoTimestamp(): string {
  return new Date().toISOString();
}

export function successResponse<T>(data: T): { success: true; data: T; timestamp: string } {
  return {
    success: true,
    data,
    timestamp: isoTimestamp(),
  };
}

export function errorResponse(
  requestContext: RequestContext | undefined,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { success: false; error: { code: string; message: string; requestId?: string; traceId?: string; details?: Record<string, unknown> }; timestamp: string } {
  return {
    success: false,
    error: {
      code,
      message,
      requestId: requestContext?.requestId,
      traceId: requestContext?.correlationId,
      ...(details ? { details } : {}),
    },
    timestamp: isoTimestamp(),
  };
}
