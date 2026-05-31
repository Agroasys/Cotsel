import { Request, Response } from 'express';
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
import { Trigger, TriggerStatus, TriggerType } from '../types/trigger';
import { listTriggers } from '../database/queries';
import { ValidationError } from '../utils/errors';

type TriggerRequestBody = {
  tradeId?: string;
  requestId?: string;
};

type RedriveRequestBody = TriggerRequestBody & {
  triggerType?: TriggerType;
};
type RouteParams = Record<string, string | string[]>;
type TriggerListQuery = {
  status?: string;
  tradeId?: string;
  limit?: string;
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
const ORACLE_TRIGGER_STATUSES: readonly string[] = Object.values(TriggerStatus);

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

function parseTriggerListQuery(query: TriggerListQuery): {
  status?: TriggerStatus;
  tradeId?: string;
  limit: number;
} {
  const limit =
    query.limit === undefined
      ? 100
      : /^\d+$/.test(query.limit)
        ? Number.parseInt(query.limit, 10)
        : Number.NaN;

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(400, 'BadRequest', 'limit must be between 1 and 200');
  }

  if (query.status !== undefined && !ORACLE_TRIGGER_STATUSES.includes(query.status)) {
    throw new HttpError(400, 'BadRequest', 'status is invalid');
  }

  return {
    status: query.status as TriggerStatus | undefined,
    tradeId: query.tradeId?.trim() || undefined,
    limit,
  };
}

function serializeTrigger(trigger: Trigger) {
  return {
    id: trigger.id,
    actionKey: trigger.action_key,
    requestId: trigger.request_id,
    idempotencyKey: trigger.idempotency_key,
    tradeId: trigger.trade_id,
    triggerType: trigger.trigger_type,
    attemptCount: trigger.attempt_count,
    status: trigger.status,
    txHash: trigger.tx_hash,
    blockNumber: trigger.block_number ? Number(trigger.block_number) : null,
    confirmationStage: trigger.confirmation_stage,
    confirmationStageAt: trigger.confirmation_stage_at?.toISOString() ?? null,
    indexerConfirmed: trigger.indexer_confirmed,
    indexerConfirmedAt: trigger.indexer_confirmed_at?.toISOString() ?? null,
    indexerEventId: trigger.indexer_event_id,
    lastError: trigger.last_error,
    errorType: trigger.error_type,
    onChainVerified: trigger.on_chain_verified,
    onChainVerifiedAt: trigger.on_chain_verified_at?.toISOString() ?? null,
    createdAt: trigger.created_at.toISOString(),
    submittedAt: trigger.submitted_at?.toISOString() ?? null,
    confirmedAt: trigger.confirmed_at?.toISOString() ?? null,
    updatedAt: trigger.updated_at.toISOString(),
    approvedBy: trigger.approved_by,
    approvedAt: trigger.approved_at?.toISOString() ?? null,
    rejectedBy: trigger.rejected_by,
    rejectedAt: trigger.rejected_at?.toISOString() ?? null,
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

  async listTriggers(
    req: Request<RouteParams, unknown, unknown, TriggerListQuery>,
    res: Response<OracleResponse | ErrorResponse>,
  ): Promise<void> {
    try {
      const query = parseTriggerListQuery(req.query);
      const triggers = await listTriggers(query);
      res.status(200).json({
        success: true,
        data: {
          items: triggers.map(serializeTrigger),
          generatedAt: timestamp(),
        },
        timestamp: timestamp(),
      } as unknown as OracleResponse);
    } catch (error: unknown) {
      Logger.error('Controller error in listTriggers', error);
      res.status(resolveStatusCode(error)).json(buildOracleErrorResponse(error));
    }
  }

  async releaseStage1(
    req: Request<RouteParams, unknown, ReleaseStage1Request>,
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
    req: Request<RouteParams, unknown, ConfirmArrivalRequest>,
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
    req: Request<RouteParams, unknown, FinalizeTradeRequest>,
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
      RouteParams,
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
    req: Request<RouteParams, unknown, ApprovalRequest>,
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
    req: Request<RouteParams, unknown, RejectRequest>,
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
