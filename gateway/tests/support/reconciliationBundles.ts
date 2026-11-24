import { attestActionEvidence } from '@agroasys/shared-db/actionEvidence';
/** SPDX-License-Identifier: Apache-2.0 */
// Signed reconciliation evidence built the way reconciliation seals it, for
// gateway tests of the trade-unpause guard (Cotsel#951, review R02).
import { generateKeyPairSync, sign } from 'node:crypto';
import { encodeBytes32String } from 'ethers';
import {
  buildRunManifest,
  findingDigest,
  manifestBytes,
  parsePublicKeys,
} from '@agroasys/shared-db/reconciliationEvidence';
import { ruleSetDigest } from '@agroasys/shared-db/containmentRecovery';

const RULES = 'cotsel.reconciliation-risk-rules.v1';
const KEY_ID = 'gateway-test-key';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

export const EVIDENCE_KEYS = parsePublicKeys(
  JSON.stringify({
    [KEY_ID]: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }),
);
export const EVIDENCE_CONTEXT = {
  chainId: 84532,
  escrowAddress: '0x1111111111111111111111111111111111111111',
};
export const INCIDENT = 'RECON-20261124-AAAA0001';
/** The incident as the escrow proposal carries it (literal bytes32). */
export const INCIDENT_REF = encodeBytes32String(INCIDENT);

const utcMinutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString().replace('Z', '').padEnd(26, '0');

const drift = (runKey: string, tradeId: string) => ({
  runKey,
  tradeId,
  severity: 'CRITICAL',
  mismatchCode: 'AMOUNT_MISMATCH',
  comparedField: 'totalAmountLocked',
  onchainValue: '100',
  indexedValue: '101',
  details: {},
});

function sealed(
  runKey: string,
  minutesAgo: number,
  parts: {
    findings?: ReturnType<typeof drift>[];
    containments?: unknown[];
    clearances?: unknown[];
  } = {},
) {
  const evidence = {
    runKey,
    status: 'COMPLETED',
    completedAt: utcMinutesAgo(minutesAgo),
    coverage: { fromBlock: '1', toBlock: '2', complete: true, fromTradeId: '1', toTradeId: '99' },
    findings: parts.findings ?? [],
    scopeTradeIds: ['42'],
  };
  const manifest = buildRunManifest(evidence, {
    keyId: KEY_ID,
    rulesVersion: RULES,
    rulesDigest: ruleSetDigest(RULES)!,
    sealed: {
      containments: (parts.containments ?? []) as never,
      clearances: (parts.clearances ?? []) as never,
      context: EVIDENCE_CONTEXT,
    },
  });
  const signature = sign('sha256', manifestBytes(manifest), privateKey).toString('base64');
  return { runKey, seal: { manifest, signature, keyId: KEY_ID }, evidence };
}

/** The recovery bundle reconciliation would serve for trade 42, in a given situation. */
export function recoveryBundle(
  situation: 'cleared' | 'contained' | 'no_containment' | 'stale',
): unknown {
  const opening = sealed('run-a', 120, { findings: [drift('run-a', '42')] });
  const entry = {
    tradeId: '42',
    incidentReference: INCIDENT,
    episode: 1,
    state: situation === 'contained' ? 'CONTAINED' : 'RECONCILED_PENDING_APPROVAL',
    openedRunKey: 'run-a',
    clearedRunKey: situation === 'contained' ? null : 'run-c',
    citedFindings: [{ runKey: 'run-a', digest: findingDigest(drift('run-a', '42')) }],
  };
  if (situation === 'no_containment') {
    return { tradeId: '42', latest: sealed('run-z', 2), runs: {} };
  }
  const clearing = sealed('run-c', situation === 'stale' ? 60 * 24 : 5, {
    containments: [entry],
    clearances:
      situation === 'contained' ? [] : [{ tradeId: '42', incidentReference: INCIDENT, episode: 1 }],
  });
  return { tradeId: '42', latest: clearing, runs: { 'run-a': opening, 'run-c': clearing } };
}

/** A fetch that serves one recovery bundle, as reconciliation's internal port would. */
export async function attestResponse(bundle: object, input: string) {
  const url = new URL(input);
  return attestActionEvidence(bundle, {
    challenge: url.searchParams.get('challenge')!,
    resource: url.pathname,
    signer: { keyId: KEY_ID, sign: async (bytes) => sign('sha256', bytes, privateKey) },
  });
}
export function servingFetch(bundle: unknown): typeof fetch {
  return (async (input) =>
    new Response(JSON.stringify(await attestResponse(bundle as object, String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}
