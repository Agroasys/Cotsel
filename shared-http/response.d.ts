export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

export interface ApiFailureResponse {
  success: false;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export class HttpError extends Error {
  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>);
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

export function timestamp(): string;
export function success<T>(data: T): ApiSuccessResponse<T>;
export function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiFailureResponse;
