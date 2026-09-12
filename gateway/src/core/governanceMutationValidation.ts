/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { isAddress, ZeroAddress } from 'ethers';
import { GatewayError } from '../errors';
import { validateEvidenceLink } from './evidenceValidation';
import type { EvidenceLink } from './governanceStore';
import type { GovernanceMutationAuditInput } from './governanceMutationTypes';

export function validateGovernanceAuditInput(raw: unknown): GovernanceMutationAuditInput {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  if (body.actionId !== undefined) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'actionId is server-generated and must not be provided by the client',
    );
  }
  const audit = body.audit;
  if (!audit || typeof audit !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must include audit metadata');
  }

  const auditRecord = audit as Record<string, unknown>;
  const reason = typeof auditRecord.reason === 'string' ? auditRecord.reason.trim() : '';
  const ticketRef = typeof auditRecord.ticketRef === 'string' ? auditRecord.ticketRef.trim() : '';
  const evidenceLinks = Array.isArray(auditRecord.evidenceLinks)
    ? (auditRecord.evidenceLinks as EvidenceLink[])
    : [];

  if (reason.length < 8 || reason.length > 2000) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'audit.reason must be between 8 and 2000 characters',
    );
  }

  if (ticketRef.length < 2 || ticketRef.length > 128) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'audit.ticketRef must be between 2 and 128 characters',
    );
  }

  if (evidenceLinks.length < 1) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'audit.evidenceLinks must contain at least one item',
    );
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
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'Path parameter proposalId must be a non-negative integer',
    );
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
