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
