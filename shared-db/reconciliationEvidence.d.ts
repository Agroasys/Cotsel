import type { KeyObject } from 'node:crypto';

export const FINDING_SCHEMA: 'cotsel.reconciliation-finding.v1';
export const MANIFEST_SCHEMA: 'cotsel.reconciliation-run-manifest.v1';

export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SignedFinding {
  runKey: string;
  tradeId: string;
  severity: string;
  mismatchCode: string;
  comparedField: string;
  onchainValue: string | null;
  indexedValue: string | null;
  details: Record<string, unknown>;
}

export interface RunEvidence {
  runKey: string;
  status: string;
  completedAt: string | null;
  coverage: {
    fromBlock: string | null;
    toBlock: string | null;
    complete: boolean | null;
    fromTradeId: string | null;
    toTradeId: string | null;
  };
  findings: SignedFinding[];
  scopeTradeIds: string[];
}

export interface RunManifest {
  schemaVersion: typeof MANIFEST_SCHEMA;
  runKey: string;
  status: string;
  completedAt: string | null;
  coverage: RunEvidence['coverage'];
  findings: { count: number; digests: string[] };
  scope: { count: number; digest: string };
  rules: { version: string; digest: string };
  keyId: string;
}

export type RunVerification =
  | { ok: true; manifest: RunManifest }
  | {
      ok: false;
      reason:
        | 'unsigned'
        | 'unknown_key'
        | 'manifest_invalid'
        | 'bad_signature'
        | 'run_mismatch'
        | 'findings_mismatch'
        | 'scope_mismatch';
    };

export function canonicalJson(value: unknown): string;
export function findingDigest(finding: SignedFinding): string;
export function scopeDigest(tradeIds: Iterable<string>): string;
export function readRunEvidence(db: QueryExecutor, runKey: string): Promise<RunEvidence | null>;
export function buildRunManifest(
  evidence: RunEvidence,
  meta: { keyId: string; rulesVersion: string; rulesDigest: string },
): RunManifest;
export function manifestBytes(manifest: RunManifest): Buffer;
export function parsePublicKeys(json: string): Map<string, KeyObject>;
export function verifyRunEvidence(
  db: QueryExecutor,
  runKey: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
): Promise<RunVerification>;

export interface ClassifiedFinding {
  tradeId: string | null;
  mismatchCode: string | null;
  comparedField: string | null;
  digest: string;
  status: 'verified' | 'failed' | 'missing' | 'unsigned';
}
export function classifyRunFindings(
  db: QueryExecutor,
  runKey: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
): Promise<{ run: RunVerification; findings: ClassifiedFinding[] }>;

export interface ContainmentEvidence {
  findings: Array<{
    digest: string;
    mismatchCode: string | null;
    comparedField: string | null;
    status: ClassifiedFinding['status'];
  }>;
  evidence: { status: 'verified' | 'failed' | 'unsigned'; reason: string | null };
}
export function verifyContainmentEvidence(
  db: QueryExecutor,
  row: {
    opened_run_key: string;
    cleared_run_key: string | null;
    evidence: {
      findings?: Array<{ digest?: string; mismatchCode?: string; comparedField?: string }>;
    } | null;
  },
  publicKeys: ReadonlyMap<string, KeyObject>,
): Promise<ContainmentEvidence>;

/** A run's evidence rows and seal, as plain JSON (loadable or received over HTTP). */
export interface RunEvidenceBundle {
  runKey: string;
  seal: { manifest: RunManifest; signature: string; keyId: string } | null;
  evidence: RunEvidence | null;
}
export interface ContainmentRow {
  trade_id: string;
  incident_reference: string;
  state: 'CONTAINED' | 'RECONCILED_PENDING_APPROVAL' | 'RELEASED';
  opened_run_key: string;
  opened_at: string;
  qualifying_codes: string[];
  cleared_run_key: string | null;
  evidence: {
    rules?: { version?: string };
    findings?: Array<{ digest?: string; mismatchCode?: string; comparedField?: string }>;
  } | null;
}
export interface ContainmentEvidenceBundle {
  containment: ContainmentRow;
  opening: RunEvidenceBundle;
  clearing: RunEvidenceBundle | null;
}
export function loadRunEvidenceBundle(
  db: QueryExecutor,
  runKey: string,
): Promise<RunEvidenceBundle>;
export function verifyRunEvidenceBundle(
  bundle: RunEvidenceBundle,
  publicKeys: ReadonlyMap<string, KeyObject>,
): RunVerification;
export function classifyRunEvidenceBundle(
  bundle: RunEvidenceBundle,
  publicKeys: ReadonlyMap<string, KeyObject>,
): { run: RunVerification; findings: ClassifiedFinding[] };
export function loadContainmentEvidenceBundle(
  db: QueryExecutor,
  tradeId: string,
): Promise<ContainmentEvidenceBundle | null>;
export function loadOpenContainmentEvidenceBundles(
  db: QueryExecutor,
  limit?: number,
): Promise<ContainmentEvidenceBundle[]>;
export function verifyContainmentBundle(
  bundle: ContainmentEvidenceBundle,
  publicKeys: ReadonlyMap<string, KeyObject>,
): ContainmentEvidence;
