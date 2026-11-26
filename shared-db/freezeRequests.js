'use strict';
const { createHash } = require('node:crypto');
const {
  canonicalJson,
  verifyRunEvidenceBundle,
  verifyContainmentBundle,
} = require('./reconciliationEvidence');

/** One immutable request per incident; repeated observations keep its identity. */
function buildFreezeRequest(manifest, entry) {
  if (!manifest.context || !entry?.citedFindings?.length || entry.openedRunKey !== manifest.runKey)
    throw new Error('The opening run must bind the incident and its findings');
  const payload = {
    schemaVersion: 'cotsel.governance-freeze-request.v1',
    tradeId: entry.tradeId,
    incidentReference: entry.incidentReference,
    episode: entry.episode,
    runKey: manifest.runKey,
    context: manifest.context,
    rules: manifest.rules,
    findings: [...entry.citedFindings].sort((a, b) =>
      (a.runKey + a.digest).localeCompare(b.runKey + b.digest),
    ),
    requiresGovernanceApproval: true,
  };
  return {
    ...payload,
    requestId: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  };
}

function verifyFreezeRequestBundle(bundle, publicKeys, context, options = {}) {
  try {
    const request = bundle.request,
      proof = bundle.proof;
    const checked = verifyContainmentBundle(proof, publicKeys, { context });
    if (checked.evidence.status !== 'verified')
      return { ok: false, reason: checked.evidence.reason };
    const current = proof.recovery.latest.seal.manifest.containments.find(
      (entry) => entry.tradeId === request.tradeId,
    );
    if (!current || current.episode !== request.episode || current.openedRunKey !== request.runKey)
      return { ok: false, reason: 'freeze_request_mismatch' };
    if (options.maxAgeSeconds !== undefined) {
      const completedAt = Date.parse(`${proof.recovery.latest.seal.manifest.completedAt}Z`);
      const now = options.now ?? Date.now();
      if (
        !Number.isFinite(completedAt) ||
        completedAt > now + 60_000 ||
        now - completedAt > options.maxAgeSeconds * 1000
      )
        return { ok: false, reason: 'reconciliation_evidence_stale' };
    }
    const opening = proof.recovery.runs[request.runKey];
    const verified = verifyRunEvidenceBundle(opening, publicKeys);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    const entry = verified.manifest.containments?.find(
      (item) =>
        item.tradeId === request.tradeId &&
        item.incidentReference === proof.containment.incident_reference,
    );
    if (
      !entry ||
      entry.incidentReference !== request.incidentReference ||
      canonicalJson(buildFreezeRequest(verified.manifest, entry)) !== canonicalJson(request)
    )
      return { ok: false, reason: 'freeze_request_mismatch' };
    return { ok: true, request };
  } catch {
    return { ok: false, reason: 'freeze_request_invalid' };
  }
}
module.exports = { buildFreezeRequest, verifyFreezeRequestBundle };
