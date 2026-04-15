/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AuditLogStore } from './auditLogStore';
import type { AuthSession } from './authSessionClient';
import { GatewayError } from '../errors';
import type { RequestContext } from '../middleware/requestContext';
import { resolveGatewayActorKey } from '../middleware/auth';
import type { DownstreamServiceOrchestrator } from './serviceOrchestrator';

interface TreasuryEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export interface TreasuryWorkflowAuditInput {
  reason: string;
  ticketRef: string;
  metadata?: Record<string, unknown>;
}

export interface TreasuryWorkflowReader {
  listAccountingPeriods(query: {
    status?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown>;
  listSweepBatches(query: {
    accountingPeriodId?: number;
    status?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown>;
  listEntryAccounting(query: {
    accountingState?: string;
    accountingPeriodId?: number;
    sweepBatchId?: number;
    tradeId?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown>;
  getSweepBatch(
    batchId: number,
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<unknown>;
  getEntryAccounting(
    entryId: number,
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<unknown>;
}

export type TreasuryWorkflowMutationContext = {
  requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  route: string;
  method: string;
  session: AuthSession;
  audit: TreasuryWorkflowAuditInput;
};

export interface TreasuryWorkflowClient extends TreasuryWorkflowReader {
  createAccountingPeriod(
    input: {
      periodKey: string;
      startsAt: string;
      endsAt: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  requestAccountingPeriodClose(
    periodId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  closeAccountingPeriod(
    periodId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  createSweepBatch(
    input: {
      batchKey: string;
      accountingPeriodId: number;
      assetSymbol: string;
      expectedTotalRaw: string;
      payoutReceiverAddress?: string | null;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  addSweepBatchEntry(
    batchId: number,
    input: {
      ledgerEntryId: number;
      entryAmountRaw?: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  requestSweepBatchApproval(
    batchId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  approveSweepBatch(batchId: number, context: TreasuryWorkflowMutationContext): Promise<unknown>;
  markSweepBatchExecuted(
    batchId: number,
    input: {
      matchedSweepTxHash: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  recordPartnerHandoff(
    batchId: number,
    input: {
      partnerName: string;
      partnerReference: string;
      handoffStatus: string;
      evidenceReference?: string | null;
      metadata?: Record<string, unknown>;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
  closeSweepBatch(batchId: number, context: TreasuryWorkflowMutationContext): Promise<unknown>;
  createEntryRealization(
    entryId: number,
    input: {
      accountingPeriodId: number;
      sweepBatchId?: number | null;
      partnerHandoffId?: number | null;
      note?: string | null;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown>;
}

function describeActor(session: AuthSession): string {
  const parts = [session.userId];
  if (session.walletAddress) {
    parts.push(session.walletAddress.toLowerCase());
  }
  if (session.email) {
    parts.push(session.email);
  }

  return parts.join('|');
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', message);
  }

  return value as Record<string, unknown>;
}

async function parseTreasuryResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();
  let payload: TreasuryEnvelope<T> | null = null;

  if (text.trim()) {
    try {
      payload = JSON.parse(text) as TreasuryEnvelope<T>;
    } catch {
      payload = null;
    }
  }

  if (response.status === 404) {
    throw new GatewayError(404, 'NOT_FOUND', payload?.error?.message ?? fallbackMessage);
  }

  if (response.status === 409) {
    throw new GatewayError(409, 'CONFLICT', payload?.error?.message ?? fallbackMessage, {
      upstream: 'treasury',
      details: payload?.error?.details,
    });
  }

  if (response.status >= 400) {
    throw new GatewayError(
      response.status === 400 ? 400 : 502,
      response.status === 400 ? 'VALIDATION_ERROR' : 'UPSTREAM_UNAVAILABLE',
      payload?.error?.message ?? fallbackMessage,
      {
        upstream: 'treasury',
        upstreamStatus: response.status,
        upstreamCode: payload?.error?.code,
        details: payload?.error?.details,
      },
    );
  }

  if (!payload?.success) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', fallbackMessage, { upstream: 'treasury' });
  }

  return payload.data as T;
}

export class TreasuryWorkflowService implements TreasuryWorkflowClient {
  constructor(
    private readonly orchestrator: DownstreamServiceOrchestrator,
    private readonly auditLogStore: AuditLogStore,
  ) {}

  async listAccountingPeriods(query: {
    status?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown> {
    const { requestContext, ...queryParams } = query;
    const response = await this.orchestrator.fetch('treasury', {
      method: 'GET',
      path: '/api/treasury/v1/accounting-periods',
      query: queryParams,
      readOnly: true,
      authenticated: true,
      requestContext,
      operation: 'treasury:listAccountingPeriods',
    });

    return parseTreasuryResponse(response, 'Failed to list treasury accounting periods');
  }

  async listSweepBatches(query: {
    accountingPeriodId?: number;
    status?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown> {
    const { requestContext, ...queryParams } = query;
    const response = await this.orchestrator.fetch('treasury', {
      method: 'GET',
      path: '/api/treasury/v1/sweep-batches',
      query: queryParams,
      readOnly: true,
      authenticated: true,
      requestContext,
      operation: 'treasury:listSweepBatches',
    });

    return parseTreasuryResponse(response, 'Failed to list treasury sweep batches');
  }

  async listEntryAccounting(query: {
    accountingState?: string;
    accountingPeriodId?: number;
    sweepBatchId?: number;
    tradeId?: string;
    limit: number;
    offset: number;
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>;
  }): Promise<unknown> {
    const { requestContext, ...queryParams } = query;
    const response = await this.orchestrator.fetch('treasury', {
      method: 'GET',
      path: '/api/treasury/v1/entries/accounting',
      query: queryParams,
      readOnly: true,
      authenticated: true,
      requestContext,
      operation: 'treasury:listEntryAccounting',
    });

    return parseTreasuryResponse(response, 'Failed to list treasury entry accounting state');
  }

  async getSweepBatch(
    batchId: number,
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<unknown> {
    const response = await this.orchestrator.fetch('treasury', {
      method: 'GET',
      path: `/api/treasury/v1/sweep-batches/${batchId}`,
      readOnly: true,
      authenticated: true,
      requestContext,
      operation: 'treasury:getSweepBatch',
    });

    return parseTreasuryResponse(response, 'Failed to read treasury sweep batch');
  }

  async getEntryAccounting(
    entryId: number,
    requestContext?: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<unknown> {
    const response = await this.orchestrator.fetch('treasury', {
      method: 'GET',
      path: `/api/treasury/v1/entries/${entryId}/accounting`,
      readOnly: true,
      authenticated: true,
      requestContext,
      operation: 'treasury:getEntryAccounting',
    });

    return parseTreasuryResponse(response, 'Failed to read treasury entry accounting state');
  }

  async createAccountingPeriod(
    input: {
      periodKey: string;
      startsAt: string;
      endsAt: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      '/api/treasury/v1/internal/accounting-periods',
      'treasury.accounting_period.created',
      {
        ...input,
        createdBy: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async requestAccountingPeriodClose(
    periodId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/accounting-periods/${periodId}/request-close`,
      'treasury.accounting_period.pending_close',
      {
        actor: describeActor(context.session),
        closeReason: context.audit.reason,
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async closeAccountingPeriod(
    periodId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/accounting-periods/${periodId}/close`,
      'treasury.accounting_period.closed',
      {
        actor: describeActor(context.session),
        closeReason: context.audit.reason,
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async createSweepBatch(
    input: {
      batchKey: string;
      accountingPeriodId: number;
      assetSymbol: string;
      expectedTotalRaw: string;
      payoutReceiverAddress?: string | null;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      '/api/treasury/v1/internal/sweep-batches',
      'treasury.sweep_batch.created',
      {
        ...input,
        createdBy: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async addSweepBatchEntry(
    batchId: number,
    input: {
      ledgerEntryId: number;
      entryAmountRaw?: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/entries`,
      'treasury.sweep_batch.entry_added',
      {
        ...input,
        allocatedBy: describeActor(context.session),
      },
      context,
    );
  }

  async requestSweepBatchApproval(
    batchId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/request-approval`,
      'treasury.sweep_batch.approval_requested',
      {
        actor: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async approveSweepBatch(
    batchId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/approve`,
      'treasury.sweep_batch.approved',
      {
        actor: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async markSweepBatchExecuted(
    batchId: number,
    input: {
      matchedSweepTxHash: string;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/match-execution`,
      'treasury.sweep_batch.execution_matched',
      {
        ...input,
        actor: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async recordPartnerHandoff(
    batchId: number,
    input: {
      partnerName: string;
      partnerReference: string;
      handoffStatus: string;
      evidenceReference?: string | null;
      metadata?: Record<string, unknown>;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/external-handoff`,
      'treasury.sweep_batch.external_handoff_recorded',
      {
        ...input,
        metadata: {
          ...this.buildTreasuryMetadata(context),
          ...(input.metadata ?? {}),
        },
      },
      context,
    );
  }

  async closeSweepBatch(
    batchId: number,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/sweep-batches/${batchId}/close`,
      'treasury.sweep_batch.closed',
      {
        actor: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  async createEntryRealization(
    entryId: number,
    input: {
      accountingPeriodId: number;
      sweepBatchId?: number | null;
      partnerHandoffId?: number | null;
      note?: string | null;
    },
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    return this.mutate(
      `/api/treasury/v1/internal/entries/${entryId}/realizations`,
      'treasury.entry.realized',
      {
        ...input,
        actor: describeActor(context.session),
        metadata: this.buildTreasuryMetadata(context),
      },
      context,
    );
  }

  private buildTreasuryMetadata(context: TreasuryWorkflowMutationContext): Record<string, unknown> {
    return {
      gatewayActorKey: resolveGatewayActorKey(context.session),
      gatewayUserId: context.session.userId,
      gatewayWalletAddress: context.session.walletAddress,
      gatewayRole: context.session.role,
      auditReason: context.audit.reason,
      auditTicketRef: context.audit.ticketRef,
      ...(context.audit.metadata ?? {}),
    };
  }

  private async mutate(
    path: string,
    eventType: string,
    body: Record<string, unknown>,
    context: TreasuryWorkflowMutationContext,
  ): Promise<unknown> {
    const response = await this.orchestrator.fetch('treasury', {
      method: 'POST',
      path,
      body,
      readOnly: false,
      authenticated: true,
      requestContext: context.requestContext,
      operation: eventType,
    });

    const data = await parseTreasuryResponse<unknown>(
      response,
      `Failed treasury operation ${eventType}`,
    );

    await this.auditLogStore.append({
      eventType,
      route: context.route,
      method: context.method,
      requestId: context.requestContext?.requestId ?? 'unknown',
      correlationId: context.requestContext?.correlationId ?? null,
      actorId: resolveGatewayActorKey(context.session),
      actorUserId: context.session.userId,
      actorWalletAddress: context.session.walletAddress,
      actorRole: context.session.role,
      status: 'success',
      metadata: assertRecord(
        {
          treasuryPath: path,
          ticketRef: context.audit.ticketRef,
          reason: context.audit.reason,
          result: data,
        },
        'Failed to build treasury audit payload',
      ),
    });

    return data;
  }
}
