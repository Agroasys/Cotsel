/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { isAddress, ZeroAddress } from 'ethers';
import { GatewayConfig } from '../config/env';
import { AuditLogEntry } from './auditLogStore';
import {
  buildGovernanceIntentKey,
  EvidenceLink,
  GovernanceActionAuditRecord,
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernanceActionStore,
  GovernanceActionStatus,
} from './governanceStore';
import { GatewayPrincipal } from '../middleware/auth';
import { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';
import { GovernanceWriteStore } from './governanceWriteStore';
import { validateEvidenceLink } from './evidenceValidation';


export interface GovernanceMutationAuditInput {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
}

export interface GovernanceMutationAccepted {
  actionId: string;
  intentKey: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  acceptedAt: string;
  expiresAt: string | null;
}

export interface GovernanceActionPrepared {
  actionId: string;
  intentKey: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: 'prepared';
  preparedAt: string;
  expiresAt: string | null;
}

export interface GovernanceBroadcastConfirmed {
  actionId: string;
  txHash: string;
  status: 'broadcast';
  confirmedAt: string;
}

export interface QueueGovernanceActionInput {
  category: GovernanceActionCategory;
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export interface PrepareGovernanceActionInput {
  category: GovernanceActionCategory;
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export interface ConfirmGovernanceBroadcastInput {
  actionId: string;
  txHash: string;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
}

function resolveGovernanceActorId(principal: GatewayPrincipal): string {
  return principal.session.userId
    ? `user:${principal.session.userId}`
    : `wallet:${principal.session.walletAddress.toLowerCase()}`;
}

function buildGovernanceIntentHash(intentKey: string): string {
  return createHash('sha256').update(intentKey).digest('hex');
}

export function validateGovernanceAuditInput(raw: unknown): GovernanceMutationAuditInput {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  if (body.actionId !== undefined) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'actionId is server-generated and must not be provided by the client');
  }
  const audit = body.audit;
  if (!audit || typeof audit !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must include audit metadata');
  }

  const auditRecord = audit as Record<string, unknown>;
  const reason = typeof auditRecord.reason === 'string' ? auditRecord.reason.trim() : '';
  const ticketRef = typeof auditRecord.ticketRef === 'string' ? auditRecord.ticketRef.trim() : '';
  const evidenceLinks = Array.isArray(auditRecord.evidenceLinks) ? auditRecord.evidenceLinks as EvidenceLink[] : [];

  if (reason.length < 8 || reason.length > 2000) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.reason must be between 8 and 2000 characters');
  }

  if (ticketRef.length < 2 || ticketRef.length > 128) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.ticketRef must be between 2 and 128 characters');
  }

  if (evidenceLinks.length < 1) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.evidenceLinks must contain at least one item');
  }

  evidenceLinks.forEach((link, index) => validateEvidenceLink(link, index));

  return {
    reason,
    evidenceLinks: evidenceLinks.map((link) => ({
      kind: link.kind,
      uri: link.uri.trim(),
      ...(link.note ? { note: link.note.trim() } : {}),
    })),
    ticketRef,
  };
}

export function validateProposalId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter proposalId must be a non-negative integer');
  }

  return Number.parseInt(raw, 10);
}

export function validateAddressInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid address`);
  }

  if (value === ZeroAddress) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} cannot be the zero address`);
  }

  return value;
}

function buildAuditRecord(
  audit: GovernanceMutationAuditInput,
  principal: GatewayPrincipal,
  acceptedAt: string,
): GovernanceActionAuditRecord {
  return {
    reason: audit.reason,
    evidenceLinks: audit.evidenceLinks,
    ticketRef: audit.ticketRef,
    actorSessionId: principal.sessionReference,
    actorWallet: principal.session.walletAddress,
    actorRole: principal.session.role,
    createdAt: acceptedAt,
    requestedBy: principal.session.userId,
  };
}

export class GovernanceMutationService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly actionStore: GovernanceActionStore,
    private readonly writeStore: GovernanceWriteStore,
  ) {}

  async queueAction(input: QueueGovernanceActionInput): Promise<GovernanceMutationAccepted> {
    const acceptedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(acceptedAt) + (this.config.governanceQueueTtlSeconds * 1000)).toISOString();
    const intentKey = buildGovernanceIntentKey({
      category: input.category,
      contractMethod: input.contractMethod,
      proposalId: input.proposalId ?? null,
      targetAddress: input.targetAddress ?? null,
      tradeId: input.tradeId ?? null,
      chainId: this.config.chainId,
      approverWallet: input.principal.session.walletAddress,
    });
    const intentHash = buildGovernanceIntentHash(intentKey);
    const actionId = randomUUID();
    const actorId = resolveGovernanceActorId(input.principal);

    const record: GovernanceActionRecord = {
      actionId,
      intentKey,
      intentHash,
      proposalId: input.proposalId ?? null,
      category: input.category,
      status: 'requested',
      contractMethod: input.contractMethod,
      txHash: null,
      extrinsicHash: null,
      blockNumber: null,
      tradeId: input.tradeId ?? null,
      chainId: String(this.config.chainId),
      targetAddress: input.targetAddress ?? null,
      createdAt: acceptedAt,
      expiresAt,
      executedAt: null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      endpoint: input.routePath,
      errorCode: null,
      errorMessage: null,
      flowType: 'executor',
      broadcastAt: null,
      audit: buildAuditRecord(input.audit, input.principal, acceptedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.queued',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'requested',
      metadata: {
        actionId,
        category: input.category,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        actorId,
        intentHash,
        idempotencyKey: input.idempotencyKey,
      },
    };

    const duplicateAuditEntry = (existing: GovernanceActionRecord): AuditLogEntry => ({
      eventType: 'governance.action.duplicate_reused',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: existing.actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: existing.status,
      metadata: {
        actionId: existing.actionId,
        category: existing.category,
        proposalId: existing.proposalId,
        targetAddress: existing.targetAddress,
        intentKey: existing.intentKey,
        intentHash: existing.intentHash ?? intentHash,
        actorId: existing.actorId ?? actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const saved = await this.writeStore.saveQueuedActionWithIntentDedupe(
      record,
      auditEntry,
      duplicateAuditEntry,
      acceptedAt,
    );

    const stored = saved.created ? record : (await this.actionStore.get(saved.action.actionId)) ?? saved.action;

    return {
      actionId: stored.actionId,
      intentKey: stored.intentKey,
      proposalId: stored.proposalId,
      category: stored.category,
      status: stored.status,
      acceptedAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }

  async prepareAction(input: PrepareGovernanceActionInput): Promise<GovernanceActionPrepared> {
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(preparedAt) + (this.config.governanceQueueTtlSeconds * 1000)).toISOString();
    const intentKey = buildGovernanceIntentKey({
      category: input.category,
      contractMethod: input.contractMethod,
      proposalId: input.proposalId ?? null,
      targetAddress: input.targetAddress ?? null,
      tradeId: input.tradeId ?? null,
      chainId: this.config.chainId,
      approverWallet: input.principal.session.walletAddress,
    });
    const intentHash = buildGovernanceIntentHash(intentKey);
    const actionId = randomUUID();
    const actorId = resolveGovernanceActorId(input.principal);

    const record: GovernanceActionRecord = {
      actionId,
      intentKey,
      intentHash,
      proposalId: input.proposalId ?? null,
      category: input.category,
      status: 'prepared',
      flowType: 'direct_sign',
      contractMethod: input.contractMethod,
      txHash: null,
      extrinsicHash: null,
      blockNumber: null,
      tradeId: input.tradeId ?? null,
      chainId: String(this.config.chainId),
      targetAddress: input.targetAddress ?? null,
      broadcastAt: null,
      createdAt: preparedAt,
      expiresAt,
      executedAt: null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      endpoint: input.routePath,
      errorCode: null,
      errorMessage: null,
      audit: buildAuditRecord(input.audit, input.principal, preparedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.prepared',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'prepared',
      metadata: {
        actionId,
        category: input.category,
        contractMethod: input.contractMethod,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        actorId,
        intentHash,
        idempotencyKey: input.idempotencyKey,
      },
    };

    const duplicateAuditEntry = (existing: GovernanceActionRecord): AuditLogEntry => ({
      eventType: 'governance.action.duplicate_reused',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: existing.actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: existing.status,
      metadata: {
        actionId: existing.actionId,
        category: existing.category,
        contractMethod: existing.contractMethod,
        proposalId: existing.proposalId,
        targetAddress: existing.targetAddress,
        intentKey: existing.intentKey,
        intentHash: existing.intentHash ?? intentHash,
        actorId: existing.actorId ?? actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const saved = await this.writeStore.saveDirectSignActionWithIntentDedupe(
      record,
      auditEntry,
      duplicateAuditEntry,
      preparedAt,
    );

    const stored = saved.created ? record : (await this.actionStore.get(saved.action.actionId)) ?? saved.action;

    return {
      actionId: stored.actionId,
      intentKey: stored.intentKey,
      proposalId: stored.proposalId,
      category: stored.category,
      status: 'prepared',
      preparedAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }

  async confirmBroadcast(input: ConfirmGovernanceBroadcastInput): Promise<GovernanceBroadcastConfirmed> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'txHash must be a 0x-prefixed 32-byte hex string');
    }

    const existing = await this.actionStore.get(input.actionId);
    if (!existing) {
      throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', { actionId: input.actionId });
    }

    if (existing.flowType !== 'direct_sign') {
      throw new GatewayError(409, 'CONFLICT', 'Governance action is not a direct-sign action', {
        actionId: input.actionId,
        flowType: existing.flowType,
      });
    }

    if (existing.status === 'broadcast') {
      return {
        actionId: existing.actionId,
        txHash: existing.txHash!,
        status: 'broadcast',
        confirmedAt: existing.broadcastAt!,
      };
    }

    if (existing.status !== 'prepared') {
      throw new GatewayError(409, 'CONFLICT', 'Governance action is not in prepared status', {
        actionId: input.actionId,
        status: existing.status,
      });
    }

    const actorWallet = input.principal.session.walletAddress.toLowerCase();
    const initiatingWallet = existing.audit.actorWallet.toLowerCase();
    if (actorWallet !== initiatingWallet) {
      throw new GatewayError(403, 'FORBIDDEN', 'Only the initiating admin wallet may confirm broadcast of this action', {
        actionId: input.actionId,
      });
    }

    const confirmedAt = new Date().toISOString();
    const actorId = resolveGovernanceActorId(input.principal);

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.broadcast_confirmed',
      route: input.requestContext.correlationId
        ? `/governance/actions/${input.actionId}/confirm`
        : `/governance/actions/${input.actionId}/confirm`,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: input.actionId,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'broadcast',
      metadata: {
        actionId: input.actionId,
        txHash: input.txHash,
        category: existing.category,
        contractMethod: existing.contractMethod,
      },
    };

    await this.writeStore.confirmBroadcastWithAudit(input.actionId, input.txHash, confirmedAt, auditEntry);

    return {
      actionId: input.actionId,
      txHash: input.txHash,
      status: 'broadcast',
      confirmedAt,
    };
  }
}
