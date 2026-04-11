import { createHash, randomUUID } from 'crypto';
import { CANONICALIZATION_RULES_VERSION, RicardianHashRequest } from '../types';
import { canonicalJsonStringify } from './canonicalize';

export interface HashBuildResult {
  requestId: string;
  documentRef: string;
  canonicalJson: string;
  hash: string;
  rulesVersion: string;
  metadata: Record<string, unknown>;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function verifyHashIntegrity(row: {
  hash: string;
  rulesVersion: string;
  canonicalJson: string;
}): boolean {
  const preimage = `${row.rulesVersion}:${row.canonicalJson}`;
  return sha256Hex(preimage) === row.hash;
}

export function buildRicardianHash(request: RicardianHashRequest): HashBuildResult {
  if (!request.documentRef || request.documentRef.trim().length === 0) {
    throw new Error('documentRef is required');
  }

  if (!request.terms || typeof request.terms !== 'object') {
    throw new Error('terms must be an object');
  }

  const metadata = request.metadata || {};

  const canonicalPayload = {
    documentRef: request.documentRef,
    metadata,
    terms: request.terms,
  };

  const canonicalJson = canonicalJsonStringify(canonicalPayload);
  const preimage = `${CANONICALIZATION_RULES_VERSION}:${canonicalJson}`;

  return {
    requestId: request.requestId || randomUUID(),
    documentRef: request.documentRef,
    canonicalJson,
    hash: sha256Hex(preimage),
    rulesVersion: CANONICALIZATION_RULES_VERSION,
    metadata,
  };
}
