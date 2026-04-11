import { ErrorType, TriggerStatus } from '../types/trigger';
import { Logger } from './logger';

export class OracleError extends Error {
  constructor(
    message: string,
    public errorType: ErrorType,
    public isTerminal: boolean = false,
  ) {
    super(message);
    this.name = 'OracleError';
  }
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
    return new ValidationError(message);
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
    return new NetworkError(message);
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
    return new ContractError(message, isTerminal);
  }

  Logger.info('Unclassified error - treating as retryable network error');
  return new NetworkError(message);
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
