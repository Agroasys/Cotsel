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

export const INTERNAL_ERROR_MESSAGE: string;

export interface CorrelatedRequest {
  headers?: Record<string, string | string[] | undefined>;
}

export interface InternalFailureResponse {
  status(code: number): { json(body: unknown): unknown };
  setHeader?(name: string, value: string): unknown;
}

export interface InternalFailureOptions {
  log(correlationId: string, error: unknown): void;
  statusCode?: number;
  code?: string;
  message?: string;
  /** Additional stable, non-sensitive response fields such as a machine code. */
  fields?: Record<string, string | number | boolean | null>;
}

export function isCallerFacingError(error: unknown): error is Error;
export function correlationIdFor(req: CorrelatedRequest | undefined): string;
export function sendInternalFailure(
  req: CorrelatedRequest | undefined,
  res: InternalFailureResponse,
  error: unknown,
  options: InternalFailureOptions,
): string;
