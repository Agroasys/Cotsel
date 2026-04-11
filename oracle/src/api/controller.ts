import { Request, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import {
  HttpError,
  failure,
  requireEnum,
  requireObject,
  requireString,
  timestamp,
} from '@agroasys/shared-http';
import { TriggerManager } from '../core/trigger-manager';
import { Logger } from '../utils/logger';
import {
  ApprovalRequest,
  ConfirmArrivalRequest,
  ErrorResponse,
  FinalizeTradeRequest,
  OracleResponse,
  RejectRequest,
  ReleaseStage1Request,
} from '../types';
import { TriggerType } from '../types/trigger';
import { ValidationError } from '../utils/errors';

type TriggerRequestBody = {
  tradeId?: string;
  requestId?: string;
};

type RedriveRequestBody = TriggerRequestBody & {
  triggerType?: TriggerType;
};

type TriggerExecutionResult = {
  idempotencyKey: string;
  actionKey?: string;
  status: string;
  txHash?: string;
  blockNumber?: number;
  message: string;
};

const ORACLE_TRIGGER_TYPES = Object.values(TriggerType);

function buildOracleSuccess(result: TriggerExecutionResult): OracleResponse {
  return {
    success: true,
    idempotencyKey: result.idempotencyKey,
    actionKey: result.actionKey,
    status: result.status,
    txHash: result.txHash,
    blockNumber: result.blockNumber,
    message: result.message,
    timestamp: timestamp(),
  };
}

function buildOracleErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpError) {
    return failure(error.code, error.message) as ErrorResponse;
  }

  if (error instanceof ValidationError) {
    return failure('ValidationError', error.message) as ErrorResponse;
  }

  if (error instanceof Error) {
    return failure(error.name || 'InternalError', error.message) as ErrorResponse;
  }

  return failure('InternalError', 'An unexpected oracle error occurred') as ErrorResponse;
}

function resolveStatusCode(error: unknown): number {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  if (error instanceof ValidationError) {
    return 400;
  }

  return 500;
}

function parseTriggerBody(body: unknown): { tradeId: string; requestId: string } {
  const payload = requireObject(body, 'body') as unknown as TriggerRequestBody;

  return {
    tradeId: requireString(payload.tradeId, 'tradeId'),
    requestId: requireString(payload.requestId, 'requestId'),
  };
}

function parseRedriveBody(body: unknown): {
  tradeId: string;
  requestId: string;
  triggerType: TriggerType;
} {
  const payload = requireObject(body, 'body') as unknown as RedriveRequestBody;

  return {
    tradeId: requireString(payload.tradeId, 'tradeId'),
    requestId: requireString(payload.requestId, 'requestId'),
    triggerType: requireEnum(payload.triggerType, ORACLE_TRIGGER_TYPES, 'triggerType'),
  };
}

function parseApprovalBody(body: unknown): { idempotencyKey: string; actor: string } {
  const payload = requireObject(body, 'body') as unknown as ApprovalRequest;

  return {
    idempotencyKey: requireString(payload.idempotencyKey, 'idempotencyKey'),
    actor: requireString(payload.actor, 'actor'),
  };
}

function parseRejectBody(body: unknown): {
  idempotencyKey: string;
  actor: string;
  reason?: string;
} {
  const payload = requireObject(body, 'body') as unknown as RejectRequest;

  return {
    idempotencyKey: requireString(payload.idempotencyKey, 'idempotencyKey'),
    actor: requireString(payload.actor, 'actor'),
    reason: payload.reason === undefined ? undefined : requireString(payload.reason, 'reason'),
  };
}

export class OracleController {
  constructor(private triggerManager: TriggerManager) {}

  async releaseStage1(
    req: Request<ParamsDictionary, unknown, ReleaseStage1Request>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { tradeId, requestId } = parseTriggerBody(req.body);
      const result = await this.triggerManager.executeTrigger({
        tradeId,
        requestId,
        triggerType: TriggerType.RELEASE_STAGE_1,
        requestHash: req.hmacSignature,
      });

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in releaseStage1', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async confirmArrival(
    req: Request<ParamsDictionary, unknown, ConfirmArrivalRequest>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { tradeId, requestId } = parseTriggerBody(req.body);
      const result = await this.triggerManager.executeTrigger({
        tradeId,
        requestId,
        triggerType: TriggerType.CONFIRM_ARRIVAL,
        requestHash: req.hmacSignature,
      });

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in confirmArrival', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async finalizeTrade(
    req: Request<ParamsDictionary, unknown, FinalizeTradeRequest>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { tradeId, requestId } = parseTriggerBody(req.body);
      const result = await this.triggerManager.executeTrigger({
        tradeId,
        requestId,
        triggerType: TriggerType.FINALIZE_TRADE,
        requestHash: req.hmacSignature,
      });

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in finalizeTrade', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async redriveTrigger(
    req: Request<
      ParamsDictionary,
      unknown,
      { tradeId: string; triggerType: TriggerType; requestId: string }
    >,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { tradeId, triggerType, requestId } = parseRedriveBody(req.body);
      Logger.info('Re-drive request received', { tradeId, triggerType, requestId });

      const result = await this.triggerManager.executeTrigger({
        tradeId,
        requestId,
        triggerType,
        requestHash: req.hmacSignature,
        isRedrive: true,
      });

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in redriveTrigger', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async approveTrigger(
    req: Request<ParamsDictionary, unknown, ApprovalRequest>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { idempotencyKey, actor } = parseApprovalBody(req.body);
      const result = await this.triggerManager.resumeAfterApproval(idempotencyKey, actor);

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in approveTrigger', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async rejectTrigger(
    req: Request<ParamsDictionary, unknown, RejectRequest>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const { idempotencyKey, actor, reason } = parseRejectBody(req.body);
      const result = await this.triggerManager.rejectPendingTrigger(idempotencyKey, actor, reason);

      res.status(200).json(buildOracleSuccess(result));
    } catch (error: unknown) {
      Logger.error('Controller error in rejectTrigger', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }
}
