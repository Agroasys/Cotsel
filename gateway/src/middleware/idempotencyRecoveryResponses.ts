/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from 'express';
import type {
  IdempotencyFinancialOutcome,
  IdempotencyGaslessCommand,
} from '../core/idempotencyStore';
import { errorResponse } from '../responses';

function financialOutcomeFromErrorBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  return (details as { outcome?: unknown }).outcome;
}

export function hasUnresolvedFinancialOutcome(body: unknown): boolean {
  const outcome = financialOutcomeFromErrorBody(body);
  return outcome === 'broadcast_unknown' || outcome === 'confirmation_pending';
}

export function hasTerminalFinancialFailure(body: unknown): boolean {
  return financialOutcomeFromErrorBody(body) === 'reverted';
}

export function financialOutcomeResponse(
  req: Request,
  outcome: IdempotencyFinancialOutcome,
): { statusCode: number; body: Record<string, unknown> } {
  const details = {
    transactionHash: outcome.transactionHash,
    outcome: outcome.outcomeStatus,
    resourceType: outcome.resourceType,
    resourceId: outcome.resourceId,
    operation: outcome.operation,
    chainId: outcome.chainId,
    recovered: true,
    rebroadcastAllowed: false,
  };
  if (outcome.outcomeStatus === 'reverted') {
    return {
      statusCode: 502,
      body: errorResponse(
        req.requestContext,
        'UPSTREAM_UNAVAILABLE',
        'Gasless transaction reverted on-chain',
        details,
      ),
    };
  }

  return {
    statusCode: 202,
    body: {
      success: true,
      data: { requestId: outcome.requestId, ...details, outcomeStatus: outcome.outcomeStatus },
      timestamp: new Date().toISOString(),
    },
  };
}

export function isTerminalFinancialOutcome(outcome: IdempotencyFinancialOutcome): boolean {
  return outcome.outcomeStatus === 'confirmed' || outcome.outcomeStatus === 'reverted';
}

export function gaslessCommandResponse(
  req: Request,
  command: IdempotencyGaslessCommand,
): { statusCode: number; body: Record<string, unknown>; terminal: boolean } {
  if (command.status === 'completed') {
    return {
      statusCode: 202,
      body: { success: true, data: command.result, timestamp: new Date().toISOString() },
      terminal: true,
    };
  }
  if (command.status === 'failed' || command.status === 'dead_letter') {
    return {
      statusCode: 503,
      body: errorResponse(
        req.requestContext,
        'UPSTREAM_UNAVAILABLE',
        'Durable gasless command requires operator review',
        {
          commandId: command.commandId,
          commandStatus: command.status,
          failureCode: command.lastErrorCode,
          rebroadcastAllowed: false,
        },
      ),
      terminal: true,
    };
  }
  return {
    statusCode: 202,
    body: {
      success: true,
      data: {
        requestId: command.requestId,
        commandId: command.commandId,
        commandStatus: command.status,
        resourceType: command.resourceType,
        resourceId: command.resourceId,
        operation: command.operation,
        transactionHash: command.transactionHash,
        rebroadcastAllowed: false,
      },
      timestamp: new Date().toISOString(),
    },
    terminal: false,
  };
}
