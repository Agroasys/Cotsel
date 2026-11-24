'use strict';

// Whether a trade-scoped unpause may proceed, decided only from signed
// reconciliation evidence (Cotsel#951, review R01/R02/R03, decisions Q1/Q2).
//
// Inputs are an untrusted bundle (served by reconciliation, relayed by
// anyone) and the verifier's own trusted keys, chain context and clock.
// Every fact used below comes from a signed run manifest or from a finding
// record whose digest that manifest signs. Row copies are never trusted.
//
// The newest sealed run must be fresh (signed completedAt within maxAgeSeconds)
// and signs the containment state it left. Then exactly one of:
//
// - no_reconciliation_containment (Q1): that fresh signed state lists no open
//   incident for the trade, so reconciliation positively has none. The normal
//   quorum unpause applies, unless the proposal names a RECON- incident.
// - reconciliation_recovery_verified (Q2): the trade's incident matches the
//   proposal's incident, is RECONCILED_PENDING_APPROVAL, every finding it cites
//   verifies in its own signed run and is a qualifying finding for this trade
//   under the signed rules, and the clearing run's own manifest asserts the
//   clearance of exactly this incident, completed after every cited finding,
//   and records no qualifying finding for the trade itself.
//
// Anything else is a refusal with a reason. The limit, stated plainly: the
// verifier cannot prove that no run newer than the fresh one exists, so
// completeness is bounded by maxAgeSeconds.
const { createHash } = require('node:crypto');
const {
  canonicalJson,
  findingDigest,
  verifyRunEvidenceBundle,
} = require('./reconciliationEvidence');

/** The 'contain' codes of each published rule set, with its digest. */
const RISK_RULE_SETS = Object.freeze({
  'cotsel.reconciliation-risk-rules.v1': Object.freeze({
    contain: Object.freeze([
      'AMOUNT_MISMATCH',
      'FEE_COMPONENT_MISMATCH',
      'HASH_MISMATCH',
      'INDEXER_TRADE_MISSING',
      'ONCHAIN_TRADE_MISSING',
      'PARTICIPANT_MISMATCH',
    ]),
    record: Object.freeze([
      'ARRIVAL_TIMESTAMP_MISMATCH',
      'INDEXED_INVALID_ADDRESS',
      'INDEXER_DUPLICATE_TRADE',
      'INDEXER_SURPLUS_RECORDS',
      'ONCHAIN_INVALID_ADDRESS',
      'ONCHAIN_READ_ERROR',
      'STATUS_MISMATCH',
    ]),
  }),
});

/** Same canonical form as reconciliation's RISK_RULES_V1_DIGEST. */
function ruleSetDigest(version) {
  const set = RISK_RULE_SETS[version];
  if (!set) return null;
  const rules = [
    ...set.contain.map((code) => [code, 'contain']),
    ...set.record.map((code) => [code, 'record']),
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ version, rules })).digest('hex');
}

/** to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US') is UTC without a zone suffix. */
const completedMs = (manifest) =>
  typeof manifest?.completedAt === 'string' ? Date.parse(`${manifest.completedAt}Z`) : NaN;

const refuse = (reason, detail = null) => ({ decision: 'refused', reason, detail });

function contextMatches(manifest, context) {
  return (
    manifest?.context &&
    manifest.context.chainId === context.chainId &&
    typeof manifest.context.escrowAddress === 'string' &&
    manifest.context.escrowAddress.toLowerCase() === context.escrowAddress.toLowerCase()
  );
}

/**
 * @param bundle {tradeId, latest: {runKey, seal}, runs: {[runKey]: {runKey, seal, evidence}}}
 * @param options {publicKeys, context: {chainId, escrowAddress}, maxAgeSeconds, now?,
 *                 matchesIncident?: (reference) => boolean, incidentIsReconciliation?: boolean}
 */
function verifyContainmentRecovery(bundle, options) {
  try {
    return verifyRecovery(bundle, options);
  } catch {
    return refuse('reconciliation_evidence_invalid', 'bundle_malformed');
  }
}

function verifyRecovery(bundle, options) {
  const { publicKeys, context, maxAgeSeconds } = options;
  const now = options.now ?? Date.now();
  const tradeId = bundle?.tradeId;
  if (typeof tradeId !== 'string' || !bundle.latest?.seal) {
    return refuse('reconciliation_evidence_invalid', 'bundle_malformed');
  }
  if (options.expectedTradeId !== undefined && options.expectedTradeId !== tradeId) {
    return refuse('reconciliation_evidence_invalid', 'requested_trade_mismatch');
  }

  // 1. The newest sealed run: authentic, for this chain, fresh, with a snapshot.
  const latestCheck = verifyRunEvidenceBundle(
    { runKey: bundle.latest.runKey, seal: bundle.latest.seal, evidence: null },
    publicKeys,
    { signatureOnly: true },
  );
  if (!latestCheck.ok)
    return refuse('reconciliation_evidence_invalid', `latest_${latestCheck.reason}`);
  const latest = latestCheck.manifest;
  if (latest.status !== 'COMPLETED')
    return refuse('reconciliation_evidence_invalid', 'latest_not_completed');
  if (
    !RISK_RULE_SETS[latest.rules?.version] ||
    ruleSetDigest(latest.rules.version) !== latest.rules.digest
  )
    return refuse('reconciliation_evidence_invalid', 'unknown_rules');
  if (!contextMatches(latest, context))
    return refuse('reconciliation_evidence_invalid', 'context_mismatch');
  if (!Array.isArray(latest.containments) || !Array.isArray(latest.clearances)) {
    return refuse('reconciliation_evidence_invalid', 'snapshot_missing');
  }
  const latestAt = completedMs(latest);
  if (
    !Number.isFinite(latestAt) ||
    latestAt > now + 60_000 ||
    now - latestAt > maxAgeSeconds * 1000
  ) {
    return refuse('reconciliation_evidence_stale', latest.completedAt ?? null);
  }

  // 2. Q1: a fresh signed state with no open incident for the trade.
  const entries = latest.containments.filter((entry) => entry.tradeId === tradeId);
  if (entries.length === 0) {
    if (options.incidentIsReconciliation) {
      return refuse('reconciliation_incident_without_containment');
    }
    return {
      decision: 'no_reconciliation_containment',
      evidence: { latestRunKey: latest.runKey, latestCompletedAt: latest.completedAt },
    };
  }
  if (entries.length > 1) return refuse('reconciliation_evidence_invalid', 'duplicate_trade_entry');
  const entry = entries[0];

  // 3. Q2: the proposal's incident, and a cleared state.
  if (options.matchesIncident && !options.matchesIncident(entry.incidentReference)) {
    return refuse('incident_mismatch', entry.incidentReference);
  }
  if (entry.state !== 'RECONCILED_PENDING_APPROVAL' || !entry.clearedRunKey) {
    return refuse('containment_not_cleared', entry.state);
  }

  const verifiedRuns = new Map();
  const verifiedRun = (runKey) => {
    if (verifiedRuns.has(runKey)) return verifiedRuns.get(runKey);
    const run = bundle.runs?.[runKey];
    const check = run ? verifyRunEvidenceBundle(run, publicKeys) : { ok: false, reason: 'missing' };
    const value =
      check.ok && check.manifest.status === 'COMPLETED' && contextMatches(check.manifest, context)
        ? { manifest: check.manifest, evidence: run.evidence }
        : null;
    verifiedRuns.set(runKey, value);
    return value;
  };

  // 4. Every cited finding: authentic in its own run, this trade, qualifying.
  if (!Array.isArray(entry.citedFindings) || entry.citedFindings.length === 0) {
    return refuse('reconciliation_evidence_invalid', 'no_cited_findings');
  }
  let lastDivergence = -Infinity;
  for (const cited of entry.citedFindings) {
    const run = verifiedRun(cited.runKey);
    if (!run)
      return refuse('reconciliation_evidence_invalid', `cited_run_${cited.runKey}_not_verified`);
    const record = run.evidence.findings.find((finding) => findingDigest(finding) === cited.digest);
    if (!record) return refuse('reconciliation_evidence_invalid', 'cited_finding_not_verified');
    if (record.tradeId !== tradeId) {
      return refuse('reconciliation_evidence_invalid', 'cited_finding_other_trade');
    }
    const rules = run.manifest.rules;
    if (!RISK_RULE_SETS[rules?.version] || ruleSetDigest(rules.version) !== rules.digest) {
      return refuse('reconciliation_evidence_invalid', 'unknown_rules');
    }
    if (!RISK_RULE_SETS[rules.version].contain.includes(record.mismatchCode)) {
      return refuse('reconciliation_evidence_invalid', 'cited_finding_not_qualifying');
    }
    lastDivergence = Math.max(lastDivergence, completedMs(run.manifest));
  }

  // 5. The clearance: asserted by the clearing run itself, for this incident,
  //    after the divergence, and not contradicted by that run's own findings.
  const clearing = verifiedRun(entry.clearedRunKey);
  if (!clearing) return refuse('clearance_invalid', 'clearing_run_not_verified');
  if (!clearing.evidence.scopeTradeIds.includes(tradeId)) {
    return refuse('clearance_invalid', 'clearing_trade_not_in_scope');
  }
  const asserted = (clearing.manifest.clearances ?? []).some(
    (clearance) =>
      clearance.tradeId === tradeId &&
      clearance.incidentReference === entry.incidentReference &&
      clearance.episode === entry.episode,
  );
  if (!asserted) return refuse('clearance_invalid', 'clearance_not_asserted');
  if (!(completedMs(clearing.manifest) > lastDivergence)) {
    return refuse('clearance_invalid', 'clearance_predates_divergence');
  }
  const clearingRules = RISK_RULE_SETS[clearing.manifest.rules?.version];
  if (
    !clearingRules ||
    ruleSetDigest(clearing.manifest.rules.version) !== clearing.manifest.rules.digest
  )
    return refuse('clearance_invalid', 'unknown_rules');
  const contradicted = clearing.evidence.findings.some(
    (finding) =>
      finding.tradeId === tradeId && clearingRules.contain.includes(finding.mismatchCode),
  );
  if (contradicted) return refuse('clearance_invalid', 'clearing_run_has_qualifying_finding');

  return {
    decision: 'reconciliation_recovery_verified',
    evidence: {
      latestRunKey: latest.runKey,
      latestCompletedAt: latest.completedAt,
      incidentReference: entry.incidentReference,
      episode: entry.episode,
      clearedRunKey: entry.clearedRunKey,
      citedFindings: entry.citedFindings.length,
      // Binds an approval to exactly the evidence it was prepared on.
      manifestDigest: createHash('sha256').update(canonicalJson(latest)).digest('hex'),
    },
  };
}

/**
 * Reconciliation side: the bundle a verifier needs for one trade, from the
 * newest sealed run and the runs its incident names. Read in one snapshot.
 */
async function loadContainmentRecoveryBundle(db, tradeId) {
  const latest = await db.query(
    `SELECT m.run_key, m.manifest, m.signature, m.key_id
     FROM reconcile_run_manifests m JOIN reconcile_runs r ON r.run_key = m.run_key
     ORDER BY r.completed_at DESC NULLS LAST, m.run_key DESC LIMIT 1`,
  );
  const row = latest.rows[0];
  if (!row) return null;
  const seal = { manifest: row.manifest, signature: row.signature, keyId: row.key_id };
  const entry = (row.manifest.containments ?? []).find((item) => item.tradeId === tradeId);
  const runKeys = new Set(entry ? entry.citedFindings.map((cited) => cited.runKey) : []);
  if (entry?.clearedRunKey) runKeys.add(entry.clearedRunKey);
  const { loadRunEvidenceBundle } = require('./reconciliationEvidence');
  const runs = {};
  for (const runKey of runKeys) runs[runKey] = await loadRunEvidenceBundle(db, runKey);
  return { tradeId, latest: { runKey: row.run_key, seal }, runs };
}

module.exports = {
  RISK_RULE_SETS,
  loadContainmentRecoveryBundle,
  ruleSetDigest,
  verifyContainmentRecovery,
};
