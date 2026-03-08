/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { EvidenceLink } from './governanceStore';

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

export function validateEvidenceLink(link: EvidenceLink, index: number): void {
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