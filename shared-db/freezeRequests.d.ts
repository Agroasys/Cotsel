import type { KeyObject } from 'node:crypto';
import type { RunManifest, SealedContainment } from './reconciliationEvidence';
export interface FreezeRequest {
  schemaVersion: 'cotsel.governance-freeze-request.v1';
  requestId: string;
  tradeId: string;
  incidentReference: string;
  episode: number;
  runKey: string;
  context: { chainId: number | null; escrowAddress: string };
  rules: { version: string; digest: string };
  findings: Array<{ runKey: string; digest: string }>;
  requiresGovernanceApproval: true;
}
export function buildFreezeRequest(manifest: RunManifest, entry: SealedContainment): FreezeRequest;
export function verifyFreezeRequestBundle(
  bundle: unknown,
  publicKeys: ReadonlyMap<string, KeyObject>,
  context: { chainId: number | null; escrowAddress: string },
  options?: { now?: number; maxAgeSeconds?: number },
): { ok: true; request: FreezeRequest } | { ok: false; reason: string | null };
