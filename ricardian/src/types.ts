export const CANONICALIZATION_RULES_VERSION = 'RICARDIAN_CANONICAL_V1';

export interface RicardianHashRequest {
  requestId?: string;
  documentRef: string;
  terms: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Registration body: the hashed request plus the tenant that owns it. The tenant is not hashed. */
export interface RicardianRegistrationRequest extends RicardianHashRequest {
  tenantId: string;
}

export interface RicardianHashResponse {
  id: number;
  requestId: string;
  tenantId: string;
  documentRef: string;
  hash: string;
  rulesVersion: string;
  canonicalJson: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RicardianHashRow {
  id: number;
  request_id: string;
  tenant_id: string | null;
  document_ref: string;
  hash: string;
  rules_version: string;
  canonical_json: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Minimal public attestation returned by generic hash lookup; never includes terms or metadata. */
export interface RicardianHashAttestation {
  hash: string;
  rulesVersion: string;
  registeredAt: string;
}

export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
