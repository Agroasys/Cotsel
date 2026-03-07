/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { isAddress, ZeroAddress } from 'ethers';
import { GatewayConfig } from '../config/env';
import { AuditLogEntry } from './auditLogStore';
import {
  EvidenceLink,
  GovernanceActionAuditRecord,
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernanceActionStatus,
} from './governanceStore';
import { GatewayPrincipal } from '../middleware/auth';
import { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';
import { GovernanceWriteStore } from './governanceWriteStore';

const VALID_EVIDENCE_KINDS = new Set<EvidenceLink['kind']>([
  'runbook',
  'incident',
  'ticket',
  'tx',
  'event',
  'document',
  'log',
  'dashboard',
  'other',
]);

export interface GovernanceMutationAuditInput {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
}

export interface GovernanceMutationAccepted {
  actionId: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  acceptedAt: string;
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

function validateEvidenceLink(link: EvidenceLink, index: number): void {
  if (!VALID_EVIDENCE_KINDS.has(link.kind)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].kind is invalid`);
  }

  if (typeof link.uri !== 'string' || link.uri.trim().length < 3) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].uri is required`);
  }

  if (link.note !== undefined && (typeof link.note !== 'string' || link.note.trim().length === 0)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].note must be a non-empty string when provided`);
  }
}

export function validateGovernanceAuditInput(raw: unknown): GovernanceMutationAuditInput {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
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
    actorSessionId: principal.sessionId,
    actorWallet: principal.session.walletAddress,
    actorRole: principal.session.role,
    createdAt: acceptedAt,
    requestedBy: principal.session.userId,
  };
}

export class GovernanceMutationService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly writeStore: GovernanceWriteStore,
  ) {}

  async queueAction(input: QueueGovernanceActionInput): Promise<GovernanceMutationAccepted> {
    const acceptedAt = new Date().toISOString();
    const actionId = randomUUID();

    const record: GovernanceActionRecord = {
      actionId,
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
      executedAt: null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      errorCode: null,
      errorMessage: null,
      audit: buildAuditRecord(input.audit, input.principal, acceptedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.queued',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'requested',
      metadata: {
        actionId,
        category: input.category,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    };

    await this.writeStore.saveActionWithAudit(record, auditEntry);

    return {
      actionId,
      proposalId: input.proposalId ?? null,
      category: input.category,
      status: 'requested',
      acceptedAt,
    };
  }
}
