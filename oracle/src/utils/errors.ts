import { ErrorType, TriggerStatus } from '../types/trigger';
import { Logger } from './logger';

export class OracleError extends Error {
  /**
   * WP-10 I-06. True when the oracle wrote this message itself. `classifyError`
   * clears it: text derived from an RPC, signer, or provider failure is never
   * returned to a caller, whatever type it was classified as.
   */
  callerSafe = true;

  constructor(
    message: string,
    public errorType: ErrorType,
    public isTerminal: boolean = false,
  ) {
    super(message);
    this.name = 'OracleError';
  }
}

function fromRawFailure<T extends OracleError>(error: T): T {
  error.callerSafe = false;
  return error;
}

export class ValidationError extends OracleError {
  constructor(message: string) {
    super(message, ErrorType.VALIDATION, true);
    this.name = 'ValidationError';
  }
}

export class NetworkError extends OracleError {
  constructor(message: string) {
    super(message, ErrorType.NETWORK, false);
    this.name = 'NetworkError';
  }
}

export class ContractError extends OracleError {
  constructor(message: string, isTerminal: boolean = false) {
    super(message, ErrorType.CONTRACT, isTerminal);
    this.name = 'ContractError';
  }
}

/**
 * A trade is under a PRES-11 reconciliation containment, or the guard could not
 * establish that it is not.
 *
 * Not terminal. A containment is lifted by a governed unpause, and a guard that
 * could not be read is an outage — in both cases the milestone is owed once the
 * blocker clears, so the trigger retries and then lands in
 * `EXHAUSTED_NEEDS_REDRIVE`, which pages, rather than being written off.
 */
export class TradeContainedError extends OracleError {
  constructor(
    readonly tradeId: string,
    readonly incidentReference: string | null,
    message: string,
  ) {
    super(message, ErrorType.VALIDATION, false);
    this.name = 'TradeContainedError';
  }
}

/**
 * WP-10 I-06. Text a trigger failure may carry back to its caller. Only a
 * refusal the oracle wrote itself keeps its message; the raw cause stays in the
 * trigger's `last_error` and the logs.
 */
export function publicFailureMessage(error: OracleError): string {
  return error.callerSafe ? error.message : storedFailureMessage(error.errorType);
}

/**
 * A stored `last_error` no longer records whether its text was caller-safe, so
 * replays and trigger listings return only the stable classification.
 */
export function storedFailureMessage(errorType: ErrorType | null): string {
  return `Oracle ${(errorType ?? 'unknown').toLowerCase()} failure; detail is recorded on the trigger`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function classifyError(error: unknown): OracleError {
  const message = getErrorMessage(error);
  const lowerMessage = message.toLowerCase();

  Logger.info('Classifying error', {
    message: message.substring(0, 200),
  });

  if (error instanceof OracleError) {
    return error;
  }

  // Terminal validation errors (business logic violations)
  if (
    message.includes('Cannot release stage 1') ||
    message.includes('Cannot confirm arrival') ||
    message.includes('Cannot finalize') ||
    message.includes('Invalid trade ID') ||
    message.includes('Dispute window') ||
    message.includes('expected LOCKED') ||
    message.includes('expected IN_TRANSIT') ||
    message.includes('expected ARRIVAL_CONFIRMED')
  ) {
    Logger.warn('Validation error - terminal', { message });
    return fromRawFailure(new ValidationError(message));
  }

  // Network errors (retryable)
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('fetch failed') ||
    message.includes('connection')
  ) {
    Logger.info('Network error - will retry', { message });
    return fromRawFailure(new NetworkError(message));
  }

  // Contract errors (some terminal, some retryable)
  if (
    message.includes('execution reverted') ||
    message.includes('revert') ||
    message.includes('require')
  ) {
    const isTerminal =
      lowerMessage.includes('invalid state') ||
      lowerMessage.includes('not authorized') ||
      lowerMessage.includes('trade does not exist') ||
      lowerMessage.includes('already executed') ||
      lowerMessage.includes('paused') ||
      lowerMessage.includes('oracle disabled') ||
      lowerMessage.includes('only oracle') ||
      lowerMessage.includes('proposal expired') ||
      lowerMessage.includes('timelock not elapsed');

    Logger.warn('Contract error', { isTerminal, message });
    return fromRawFailure(new ContractError(message, isTerminal));
  }

  Logger.info('Unclassified error - treating as retryable network error');
  return fromRawFailure(new NetworkError(message));
}

export function determineNextStatus(
  error: OracleError,
  attemptCount: number,
  maxAttempts: number,
): TriggerStatus {
  // terminal errors immediately fail (validation/business logic)
  if (error.isTerminal) {
    Logger.warn('Terminal error - no retry possible', {
      errorType: error.errorType,
    });
    return TriggerStatus.TERMINAL_FAILURE;
  }

  // Max attempts reached - move to recoverable exhausted state
  if (attemptCount >= maxAttempts) {
    Logger.warn('Max attempts reached - moving to EXHAUSTED_NEEDS_REDRIVE', {
      attemptCount,
      maxAttempts,
    });
    return TriggerStatus.EXHAUSTED_NEEDS_REDRIVE;
  }

  // Still retryable
  Logger.info('Error is retryable', {
    attemptCount,
    maxAttempts,
    remainingAttempts: maxAttempts - attemptCount,
  });
  return TriggerStatus.FAILED;
}
