/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { isIP } from 'net';
import type { Request } from 'express';
import {
  ACCESS_AUDIT_REFERENCE_TYPES,
  type AccessAuditReference,
  type AccessLogEntry,
  type AccessLogStore,
} from './accessLogStore';
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';

export interface AccessLogFreshness {
  source: 'gateway_access_log';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
}

export interface AccessLogEntryEnvelope {
  item: AccessLogEntry;
  freshness: AccessLogFreshness;
}

export interface AccessLogListEnvelope {
  items: AccessLogEntry[];
  nextCursor: string | null;
  freshness: AccessLogFreshness;
}

export interface AccessLogCreateInput {
  eventType: string;
  surface: string;
  outcome: string;
  auditReferences: AccessAuditReference[];
  metadata: Record<string, unknown>;
}

export interface AccessLogReader {
  record(
    input: AccessLogCreateInput,
    principal: GatewayPrincipal,
    requestContext: RequestContext,
    request: Request,
  ): Promise<AccessLogEntry>;
  list(input: {
    eventType?: string;
    outcome?: string;
    actorUserId?: string;
    limit: number;
    cursor?: string;
  }): Promise<AccessLogListEnvelope>;
  get(entryId: string): Promise<AccessLogEntryEnvelope>;
}

function validatePattern(
  value: unknown,
  field: string,
  min: number,
  max: number,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be between ${min} and ${max} characters`);
  }

  if (pattern && !pattern.test(trimmed)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} contains invalid characters`);
  }

  return trimmed;
}

function validateAuditReferences(value: unknown): AccessAuditReference[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'auditReferences must be an array');
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new GatewayError(400, 'VALIDATION_ERROR', `auditReferences[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;
    const type = validatePattern(record.type, `auditReferences[${index}].type`, 3, 64) as AccessAuditReference['type'];
    if (!ACCESS_AUDIT_REFERENCE_TYPES.includes(type)) {
      throw new GatewayError(400, 'VALIDATION_ERROR', `auditReferences[${index}].type is invalid`, {
        allowed: ACCESS_AUDIT_REFERENCE_TYPES,
      });
    }

    return {
      type,
      reference: validatePattern(record.reference, `auditReferences[${index}].reference`, 2, 256),
    };
  });
}

function validateMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'metadata must be an object');
  }

  return { ...(value as Record<string, unknown>) };
}

function hashValue(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function maskSessionFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 18) {
    return '[REDACTED]';
  }

  return `${fingerprint.slice(0, 11)}...${fingerprint.slice(-6)}`;
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }

  return trimmed;
}

function maskIpAddress(ip: string): string {
  if (isIP(ip) === 4) {
    const octets = ip.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.x`;
  }

  if (isIP(ip) === 6) {
    const segments = ip.split(':').filter((segment) => segment.length > 0);
    const [first = '::', second = ''] = segments;
    return `${first}:${second}:****:****:****:****`;
  }

  return '[REDACTED]';
}

function sourceFreshAt(items: AccessLogEntry[]): string | null {
  if (items.length === 0) {
    return null;
  }

  return items[0].createdAt;
}

export function validateAccessLogCreateRequest(raw: unknown): AccessLogCreateInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be an object');
  }

  const body = raw as Record<string, unknown>;
  return {
    eventType: validatePattern(body.eventType, 'eventType', 3, 128, /^[A-Za-z0-9._:-]+$/),
    surface: validatePattern(body.surface, 'surface', 1, 256),
    outcome: validatePattern(body.outcome, 'outcome', 2, 64, /^[A-Za-z0-9._:-]+$/),
    auditReferences: validateAuditReferences(body.auditReferences),
    metadata: validateMetadata(body.metadata),
  };
}

export class AccessLogService implements AccessLogReader {
  constructor(
    private readonly store: AccessLogStore,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  async record(
    input: AccessLogCreateInput,
    principal: GatewayPrincipal,
    requestContext: RequestContext,
    request: Request,
  ): Promise<AccessLogEntry> {
    const createdAt = this.now().toISOString();
    const ip = normalizeIp(request.ip);

    return this.store.append({
      entryId: this.idFactory(),
      eventType: input.eventType,
      surface: input.surface,
      outcome: input.outcome,
      actor: {
        userId: principal.session.userId,
        walletAddress: principal.session.walletAddress,
        role: principal.session.role,
        sessionFingerprint: principal.sessionReference,
        sessionDisplay: maskSessionFingerprint(principal.sessionReference),
      },
      network: {
        ipFingerprint: ip ? hashValue(ip) : null,
        ipDisplay: ip ? maskIpAddress(ip) : null,
        userAgent: request.get('user-agent')?.trim() || null,
      },
      request: {
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
        method: request.method,
        route: request.originalUrl || request.path,
      },
      auditReferences: input.auditReferences,
      metadata: input.metadata,
      createdAt,
    });
  }

  async list(input: {
    eventType?: string;
    outcome?: string;
    actorUserId?: string;
    limit: number;
    cursor?: string;
  }): Promise<AccessLogListEnvelope> {
    const result = await this.store.list(input);
    return {
      items: result.items,
      nextCursor: result.nextCursor,
      freshness: {
        source: 'gateway_access_log',
        sourceFreshAt: sourceFreshAt(result.items),
        queriedAt: this.now().toISOString(),
        available: true,
      },
    };
  }

  async get(entryId: string): Promise<AccessLogEntryEnvelope> {
    const item = await this.store.get(entryId);
    if (!item) {
      throw new GatewayError(404, 'NOT_FOUND', 'Access log entry not found', { entryId });
    }

    return {
      item,
      freshness: {
        source: 'gateway_access_log',
        sourceFreshAt: item.createdAt,
        queriedAt: this.now().toISOString(),
        available: true,
      },
    };
  }
}
