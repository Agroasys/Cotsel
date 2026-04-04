/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { AuditLogEntry } from './auditLogStore';
import {
  ATTESTATION_ISSUER_KINDS,
  ATTESTATION_REFERENCE_STATUSES,
  COMPLIANCE_DECISION_RESULTS,
  COMPLIANCE_DECISION_TYPES,
  COMPLIANCE_RISK_LEVELS,
  AttestationAvailability,
  AttestationFreshnessState,
  AttestationReferenceRecord,
  ComplianceAuditRecord,
  ComplianceAttestationStatusRecord,
  ComplianceDecisionRecord,
  ComplianceDecisionResult,
  ComplianceDecisionType,
  ComplianceRiskLevel,
  ComplianceStore,
  ComplianceTradeStatusRecord,
  OracleProgressionBlockRecord,
} from './complianceStore';
import { GovernanceMutationAuditInput } from './governanceMutationService';
import { resolveGatewayActorKey, type GatewayPrincipal } from '../middleware/auth';
import { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';
import { EvidenceLink } from './governanceStore';
import { ComplianceWriteStore } from './complianceWriteStore';
import { validateEvidenceLink } from './evidenceValidation';

const DENY_ONLY_REASON_CODES = new Set([
  'CMP_KYB_FAILED',
  'CMP_KYT_FAILED',
  'CMP_SANCTIONS_MATCH',
  'CMP_PROVIDER_UNAVAILABLE',
  'CMP_PROVIDER_TIMEOUT',
  'CMP_AUDIT_WRITE_FAILED',
]);
const ATTESTATION_UNAVAILABLE_REASON_CODES = new Set([
  'CMP_PROVIDER_UNAVAILABLE',
  'CMP_PROVIDER_TIMEOUT',
]);

type MutationAuditInput = GovernanceMutationAuditInput;

export interface ComplianceDecisionCreateInput {
  tradeId: string;
  decisionType: ComplianceDecisionType;
  result: ComplianceDecisionResult;
  reasonCode: string;
  provider: string;
  providerRef: string;
  subjectId: string;
  subjectType: string;
  riskLevel: ComplianceRiskLevel | null;
  overrideWindowEndsAt: string | null;
  correlationId: string;
  attestation: AttestationReferenceRecord | null;
  audit: MutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  routePath: string;
  idempotencyKey: string;
}

export interface ComplianceOperationalControlInput {
  tradeId: string;
  reasonCode: string;
  decisionId: string | null;
  audit: MutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  routePath: string;
  idempotencyKey: string;
}

function validateStringField(value: unknown, field: string, minLength: number, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be between ${minLength} and ${maxLength} characters`);
  }

  return normalized;
}


function validateAuditInput(raw: unknown): MutationAuditInput {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  const audit = body.audit;
  if (!audit || typeof audit !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must include audit metadata');
  }

  const auditRecord = audit as Record<string, unknown>;
  const reason = validateStringField(auditRecord.reason, 'audit.reason', 8, 2000);
  const ticketRef = validateStringField(auditRecord.ticketRef, 'audit.ticketRef', 2, 128);
  const evidenceLinks = Array.isArray(auditRecord.evidenceLinks) ? auditRecord.evidenceLinks as EvidenceLink[] : [];

  if (evidenceLinks.length < 1) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.evidenceLinks must contain at least one item');
  }

  evidenceLinks.forEach((link, index) => validateEvidenceLink(link, index));

  return {
    reason,
    ticketRef,
    evidenceLinks: evidenceLinks.map((link) => ({
      kind: link.kind,
      uri: link.uri.trim(),
      ...(link.note ? { note: link.note.trim() } : {}),
    })),
  };
}

function resolveComplianceActorId(principal: GatewayPrincipal): string {
  return resolveGatewayActorKey(principal.session);
}

function buildComplianceIntentHash(input: {
  tradeId: string;
  decisionType: ComplianceDecisionType;
  result: ComplianceDecisionResult;
  reasonCode: string;
  provider: string;
  providerRef: string;
  subjectId: string;
  subjectType: string;
  riskLevel: ComplianceRiskLevel | null;
  overrideWindowEndsAt: string | null;
  correlationId: string;
  actorId: string;
}): string {
  const normalizedIntent = JSON.stringify({
    actorId: input.actorId,
    tradeId: input.tradeId.trim(),
    decisionType: input.decisionType,
    result: input.result,
    reasonCode: input.reasonCode.trim(),
    provider: input.provider.trim().toLowerCase(),
    providerRef: input.providerRef.trim(),
    subjectId: input.subjectId.trim(),
    subjectType: input.subjectType.trim().toLowerCase(),
    riskLevel: input.riskLevel,
    overrideWindowEndsAt: input.overrideWindowEndsAt,
    correlationId: input.correlationId.trim(),
  });

  return createHash('sha256').update(normalizedIntent).digest('hex');
}

function buildAuditRecord(
  audit: MutationAuditInput,
  principal: GatewayPrincipal,
  createdAt: string,
): ComplianceAuditRecord {
  return {
    reason: audit.reason,
    evidenceLinks: audit.evidenceLinks,
    ticketRef: audit.ticketRef,
    actorSessionId: principal.sessionReference,
    actorWallet: principal.session.walletAddress,
    actorRole: principal.session.role,
    createdAt,
    requestedBy: principal.session.userId,
  };
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is invalid`, {
      field,
      allowed,
    });
  }

  return value as T;
}

function validateOptionalRiskLevel(value: unknown): ComplianceRiskLevel | null {
  if (value === undefined || value === null) {
    return null;
  }

  return validateEnum(value, COMPLIANCE_RISK_LEVELS, 'riskLevel');
}

function validateOptionalDecisionId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return validateStringField(value, 'decisionId', 1, 128);
}

function validateOptionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = validateStringField(value, field, 10, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid ISO timestamp`);
  }

  return normalized;
}

function validateRequiredTimestamp(value: unknown, field: string): string {
  const normalized = validateStringField(value, field, 10, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid ISO timestamp`);
  }

  return normalized;
}

function validateOptionalDisplayName(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return validateStringField(value, field, 1, 128);
}

function validateAttestationReference(raw: unknown): AttestationReferenceRecord | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'attestation must be an object when provided');
  }

  const record = raw as Record<string, unknown>;
  const issuer = record.issuer;
  if (!issuer || typeof issuer !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'attestation.issuer must be an object');
  }

  const subjectRef = record.subjectRef;
  if (!subjectRef || typeof subjectRef !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'attestation.subjectRef must be an object');
  }

  const issuerRecord = issuer as Record<string, unknown>;
  const subjectRecord = subjectRef as Record<string, unknown>;

  return {
    attestationId: validateStringField(record.attestationId, 'attestation.attestationId', 1, 256),
    attestationType: validateStringField(record.attestationType, 'attestation.attestationType', 2, 128),
    status: validateEnum(record.status, ATTESTATION_REFERENCE_STATUSES, 'attestation.status'),
    issuer: {
      id: validateStringField(issuerRecord.id, 'attestation.issuer.id', 1, 128),
      kind: validateEnum(issuerRecord.kind, ATTESTATION_ISSUER_KINDS, 'attestation.issuer.kind'),
      displayName: validateOptionalDisplayName(issuerRecord.displayName, 'attestation.issuer.displayName'),
    },
    subjectRef: {
      type: validateStringField(subjectRecord.type, 'attestation.subjectRef.type', 1, 128),
      reference: validateStringField(subjectRecord.reference, 'attestation.subjectRef.reference', 1, 256),
    },
    issuedAt: validateRequiredTimestamp(record.issuedAt, 'attestation.issuedAt'),
    expiresAt: validateOptionalTimestamp(record.expiresAt, 'attestation.expiresAt'),
    providerRef: validateStringField(record.providerRef, 'attestation.providerRef', 1, 256),
    evidenceRef: validateStringField(record.evidenceRef, 'attestation.evidenceRef', 1, 256),
    referenceHash: validateOptionalDisplayName(record.referenceHash, 'attestation.referenceHash'),
  };
}

export function validateComplianceDecisionCreateRequest(raw: unknown): Omit<ComplianceDecisionCreateInput, 'principal' | 'requestContext' | 'routePath' | 'idempotencyKey'> {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  if (body.actionId !== undefined) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'actionId is server-generated and must not be provided by the client');
  }

  if (body.decisionId !== undefined) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'decisionId is server-generated and must not be provided by the client');
  }

  const result = validateEnum(body.result, COMPLIANCE_DECISION_RESULTS, 'result');
  const reasonCode = validateStringField(body.reasonCode, 'reasonCode', 3, 128);
  const overrideWindowEndsAt = validateOptionalTimestamp(body.overrideWindowEndsAt, 'overrideWindowEndsAt');

  if (DENY_ONLY_REASON_CODES.has(reasonCode) && result !== 'DENY') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${reasonCode} requires result=DENY`);
  }

  if (reasonCode === 'CMP_OVERRIDE_ACTIVE') {
    if (result !== 'ALLOW') {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'CMP_OVERRIDE_ACTIVE requires result=ALLOW');
    }

    if (!overrideWindowEndsAt) {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'overrideWindowEndsAt is required when reasonCode=CMP_OVERRIDE_ACTIVE');
    }

    if (Date.parse(overrideWindowEndsAt) <= Date.now()) {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'overrideWindowEndsAt must be in the future');
    }
  } else if (overrideWindowEndsAt) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'overrideWindowEndsAt is allowed only when reasonCode=CMP_OVERRIDE_ACTIVE');
  }

  return {
    tradeId: validateStringField(body.tradeId, 'tradeId', 1, 128),
    decisionType: validateEnum(body.decisionType, COMPLIANCE_DECISION_TYPES, 'decisionType'),
    result,
    reasonCode,
    provider: validateStringField(body.provider, 'provider', 2, 128),
    providerRef: validateStringField(body.providerRef, 'providerRef', 2, 256),
    subjectId: validateStringField(body.subjectId, 'subjectId', 1, 256),
    subjectType: validateStringField(body.subjectType, 'subjectType', 1, 128),
    riskLevel: validateOptionalRiskLevel(body.riskLevel),
    overrideWindowEndsAt,
    correlationId: validateStringField(body.correlationId, 'correlationId', 3, 128),
    attestation: validateAttestationReference(body.attestation),
    audit: validateAuditInput(body),
  };
}

export function validateComplianceOperationalControlRequest(raw: unknown): Omit<ComplianceOperationalControlInput, 'tradeId' | 'principal' | 'requestContext' | 'routePath' | 'idempotencyKey'> {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  if (body.actionId !== undefined) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'actionId is server-generated and must not be provided by the client');
  }

  return {
    reasonCode: validateStringField(body.reasonCode, 'reasonCode', 3, 128),
    decisionId: validateOptionalDecisionId(body.decisionId),
    audit: validateAuditInput(body),
  };
}

function decisionAuditMetadata(
  decision: ComplianceDecisionRecord,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    tradeId: decision.tradeId,
    decisionType: decision.decisionType,
    result: decision.result,
    reasonCode: decision.reasonCode,
    provider: decision.provider,
    idempotencyKey,
  };
}

function blockAuditMetadata(
  block: OracleProgressionBlockRecord,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    tradeId: block.tradeId,
    latestDecisionId: block.latestDecisionId,
    blockState: block.blockState,
    reasonCode: block.reasonCode,
    idempotencyKey,
  };
}

export class ComplianceService {
  constructor(
    private readonly store: ComplianceStore,
    private readonly writeStore: ComplianceWriteStore,
  ) {}

  private async nextDecisionTimestamp(tradeId: string): Promise<string> {
    const latestDecision = await this.store.getLatestDecision(tradeId);
    const nowMs = Date.now();

    if (!latestDecision) {
      return new Date(nowMs).toISOString();
    }

    const latestMs = Date.parse(latestDecision.decidedAt);
    const decidedAtMs = Number.isNaN(latestMs) ? nowMs : Math.max(nowMs, latestMs + 1);
    return new Date(decidedAtMs).toISOString();
  }

  async getDecision(decisionId: string): Promise<ComplianceDecisionRecord | null> {
    return this.store.getDecision(decisionId);
  }

  async getTradeStatus(tradeId: string): Promise<ComplianceTradeStatusRecord | null> {
    return this.store.getTradeStatus(tradeId);
  }

  async getAttestationStatus(tradeId: string): Promise<ComplianceAttestationStatusRecord | null> {
    const latestDecision = await this.store.getLatestDecision(tradeId);
    if (!latestDecision) {
      return null;
    }

    const attestationDecision = latestDecision.attestation
      ? latestDecision
      : await this.store.getLatestDecisionWithAttestation(tradeId);

    if (!attestationDecision?.attestation) {
      return null;
    }

    const attestation = attestationDecision.attestation;
    const nowMs = Date.now();
    const expiresAtMs = attestation.expiresAt ? Date.parse(attestation.expiresAt) : Number.NaN;

    let availability: AttestationAvailability = 'available';
    let freshness: AttestationFreshnessState = 'current';
    let degradedReason: string | undefined;

    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= nowMs) {
      availability = 'degraded';
      freshness = 'expired';
      degradedReason = 'attestation_expired';
    } else if (ATTESTATION_UNAVAILABLE_REASON_CODES.has(latestDecision.reasonCode)) {
      availability = 'unavailable';
      freshness = 'stale';
      degradedReason = latestDecision.reasonCode.toLowerCase();
    } else if (attestation.status === 'expired') {
      availability = 'degraded';
      freshness = 'expired';
      degradedReason = 'attestation_expired';
    } else if (attestation.status === 'revoked') {
      availability = 'degraded';
      freshness = 'unknown';
      degradedReason = 'attestation_revoked';
    } else if (attestation.status === 'unknown') {
      availability = 'degraded';
      freshness = 'unknown';
      degradedReason = 'attestation_unknown';
    } else if (latestDecision.result === 'DENY') {
      availability = 'degraded';
      freshness = 'current';
      degradedReason = 'decision_denied';
    }

    return {
      tradeId,
      decisionId: latestDecision.decisionId,
      decisionType: latestDecision.decisionType,
      complianceResult: latestDecision.result,
      reasonCode: latestDecision.reasonCode,
      availability,
      freshness,
      ...(degradedReason ? { degradedReason } : {}),
      verifiedAt: attestationDecision.decidedAt,
      updatedAt: latestDecision.decidedAt,
      attestation,
    };
  }

  async listTradeDecisions(tradeId: string, limit: number, cursor?: string): Promise<{ items: ComplianceDecisionRecord[]; nextCursor: string | null }> {
    return this.store.listTradeDecisions({ tradeId, limit, cursor });
  }

  async createDecision(input: ComplianceDecisionCreateInput): Promise<ComplianceDecisionRecord> {
    const [decidedAt, existingBlock] = await Promise.all([
      this.nextDecisionTimestamp(input.tradeId),
      this.store.getOracleProgressionBlock(input.tradeId),
    ]);
    const actorId = resolveComplianceActorId(input.principal);

    const decision: ComplianceDecisionRecord = {
      decisionId: randomUUID(),
      tradeId: input.tradeId,
      decisionType: input.decisionType,
      result: input.result,
      reasonCode: input.reasonCode,
      provider: input.provider,
      providerRef: input.providerRef,
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      riskLevel: input.riskLevel,
      correlationId: input.correlationId,
      decidedAt,
      overrideWindowEndsAt: input.overrideWindowEndsAt,
      blockState: existingBlock?.blockState ?? 'not_blocked',
      idempotencyKey: input.idempotencyKey,
      actorId,
      endpoint: input.routePath,
      intentHash: buildComplianceIntentHash({
        tradeId: input.tradeId,
        decisionType: input.decisionType,
        result: input.result,
        reasonCode: input.reasonCode,
        provider: input.provider,
        providerRef: input.providerRef,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        riskLevel: input.riskLevel,
        overrideWindowEndsAt: input.overrideWindowEndsAt,
        correlationId: input.correlationId,
        actorId,
      }),
      attestation: input.attestation,
      audit: buildAuditRecord(input.audit, input.principal, decidedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'compliance.decision.recorded',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: decision.decisionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'recorded',
      metadata: {
        ...decisionAuditMetadata(decision, input.idempotencyKey),
        actorId,
        intentHash: decision.intentHash,
      },
    };

    return this.writeStore.saveDecisionWithAudit(decision, auditEntry);
  }

  async blockOracleProgression(input: ComplianceOperationalControlInput): Promise<ComplianceTradeStatusRecord> {
    const existingBlock = await this.store.getOracleProgressionBlock(input.tradeId);
    if (existingBlock && existingBlock.blockState === 'blocked') {
      throw new GatewayError(409, 'CONFLICT', 'Oracle progression is already blocked for this trade', {
        tradeId: input.tradeId,
      });
    }

    const decision = await this.resolveDecisionForTrade(input.tradeId, input.decisionId);
    if (!decision) {
      throw new GatewayError(409, 'CONFLICT', 'A compliance decision must exist before blocking oracle progression', {
        tradeId: input.tradeId,
      });
    }

    const updatedAt = new Date().toISOString();
    const block: OracleProgressionBlockRecord = {
      tradeId: input.tradeId,
      latestDecisionId: decision.decisionId,
      blockState: 'blocked',
      reasonCode: input.reasonCode,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      audit: buildAuditRecord(input.audit, input.principal, updatedAt),
      blockedAt: updatedAt,
      resumedAt: null,
      updatedAt,
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'compliance.oracle_progression.blocked',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: decision.decisionId,
      idempotencyKey: input.idempotencyKey,
      actorId: resolveComplianceActorId(input.principal),
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'blocked',
      metadata: blockAuditMetadata(block, input.idempotencyKey),
    };

    await this.writeStore.saveBlockStateWithAudit(block, auditEntry);
    return this.requireTradeStatus(input.tradeId);
  }

  async resumeOracleProgression(input: ComplianceOperationalControlInput): Promise<ComplianceTradeStatusRecord> {
    const existingBlock = await this.store.getOracleProgressionBlock(input.tradeId);
    if (!existingBlock || existingBlock.blockState === 'not_blocked') {
      throw new GatewayError(409, 'CONFLICT', 'Oracle progression is not currently blocked for this trade', {
        tradeId: input.tradeId,
      });
    }

    const [requestedDecision, latestDecision] = await Promise.all([
      this.resolveDecisionForTrade(input.tradeId, input.decisionId),
      this.store.getLatestDecision(input.tradeId),
    ]);
    if (!latestDecision) {
      throw new GatewayError(409, 'CONFLICT', 'An ALLOW compliance decision is required before resuming oracle progression', {
        tradeId: input.tradeId,
      });
    }

    if (requestedDecision && requestedDecision.decisionId !== latestDecision.decisionId) {
      throw new GatewayError(409, 'CONFLICT', 'The latest effective compliance decision must be used when resuming oracle progression', {
        tradeId: input.tradeId,
        decisionId: requestedDecision.decisionId,
        latestDecisionId: latestDecision.decisionId,
      });
    }

    if (latestDecision.result !== 'ALLOW') {
      throw new GatewayError(409, 'CONFLICT', 'The latest effective compliance decision must be ALLOW before resuming oracle progression', {
        tradeId: input.tradeId,
        decisionId: latestDecision.decisionId,
        result: latestDecision.result,
      });
    }

    if (latestDecision.reasonCode === 'CMP_OVERRIDE_ACTIVE') {
      if (!latestDecision.overrideWindowEndsAt || Date.parse(latestDecision.overrideWindowEndsAt) <= Date.now()) {
        throw new GatewayError(409, 'CONFLICT', 'The active override window has expired; oracle progression cannot be resumed', {
          tradeId: input.tradeId,
          decisionId: latestDecision.decisionId,
        });
      }
    }

    const updatedAt = new Date().toISOString();
    const block: OracleProgressionBlockRecord = {
      ...existingBlock,
      latestDecisionId: latestDecision.decisionId,
      blockState: 'not_blocked',
      reasonCode: input.reasonCode,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      audit: buildAuditRecord(input.audit, input.principal, updatedAt),
      resumedAt: updatedAt,
      updatedAt,
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'compliance.oracle_progression.resumed',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: latestDecision.decisionId,
      idempotencyKey: input.idempotencyKey,
      actorId: resolveComplianceActorId(input.principal),
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'not_blocked',
      metadata: blockAuditMetadata(block, input.idempotencyKey),
    };

    await this.writeStore.saveBlockStateWithAudit(block, auditEntry);
    return this.requireTradeStatus(input.tradeId);
  }

  private async resolveDecisionForTrade(
    tradeId: string,
    decisionId: string | null,
  ): Promise<ComplianceDecisionRecord | null> {
    if (decisionId) {
      const decision = await this.store.getDecision(decisionId);
      if (!decision) {
        throw new GatewayError(404, 'NOT_FOUND', 'Compliance decision not found', { decisionId });
      }

      if (decision.tradeId !== tradeId) {
        throw new GatewayError(409, 'CONFLICT', 'Compliance decision does not belong to the requested trade', {
          tradeId,
          decisionId,
        });
      }

      return decision;
    }

    return this.store.getLatestDecision(tradeId);
  }

  private async requireTradeStatus(tradeId: string): Promise<ComplianceTradeStatusRecord> {
    const status = await this.store.getTradeStatus(tradeId);
    if (!status) {
      throw new GatewayError(500, 'INTERNAL_ERROR', 'Failed to assemble compliance trade status after mutation', {
        tradeId,
      });
    }

    return status;
  }
}
