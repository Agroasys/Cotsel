'use strict';

const {
  canonicalJson,
  findingDigest,
  verifyRunEvidenceBundle,
  classifyRunEvidenceBundle,
} = require('./reconciliationEvidence');
const {
  verifyContainmentRecovery,
  RISK_RULE_SETS,
  ruleSetDigest,
} = require('./containmentRecovery');

/** Authenticate display metadata and finding lineage; recovery separately checks freshness. */
function verifyContainmentSnapshot(bundle, publicKeys, options = {}) {
  const failed = (reason, findings = []) => ({ findings, evidence: { status: 'failed', reason } });
  try {
    const row = bundle.containment;
    const recovery = bundle.recovery;
    if (!recovery?.latest?.seal) {
      return {
        findings: [],
        evidence: { status: 'unsigned', reason: 'signed_incident_snapshot_missing' },
      };
    }
    if (recovery.tradeId !== row.trade_id) return failed('requested_trade_mismatch');
    const checked = verifyRunEvidenceBundle(recovery.latest, publicKeys, { signatureOnly: true });
    if (!checked.ok) return failed(`latest_${checked.reason}`);
    const latest = checked.manifest;
    if (
      latest.status !== 'COMPLETED' ||
      !RISK_RULE_SETS[latest.rules?.version] ||
      ruleSetDigest(latest.rules.version) !== latest.rules.digest
    )
      return failed('unknown_rules');
    const entries = latest.containments?.filter((entry) => entry.tradeId === row.trade_id);
    if (entries?.length !== 1) return failed('incident_snapshot_missing');
    const entry = entries[0];
    if (
      (entry.openedAt && Date.parse(entry.openedAt) !== Date.parse(`${row.opened_at}Z`)) ||
      (entry.qualifyingCodes &&
        canonicalJson([...entry.qualifyingCodes].sort()) !==
          canonicalJson([...row.qualifying_codes].sort()))
    )
      return failed('incident_snapshot_mismatch');
    if (
      entry.incidentReference !== row.incident_reference ||
      entry.state !== row.state ||
      entry.openedRunKey !== row.opened_run_key ||
      entry.clearedRunKey !== row.cleared_run_key
    ) {
      return failed('incident_snapshot_mismatch');
    }
    const context = options.context ?? latest.context;
    if (
      !context ||
      latest.context?.chainId !== context.chainId ||
      latest.context?.escrowAddress.toLowerCase() !== context.escrowAddress.toLowerCase()
    )
      return failed('context_mismatch');
    if (!entry.citedFindings?.length)
      return {
        findings: [],
        evidence: { status: 'unsigned', reason: 'containment_predates_signed_findings' },
      };
    const findings = [];
    for (const cited of entry.citedFindings) {
      const run = recovery.runs?.[cited.runKey];
      const verified = verifyRunEvidenceBundle(run, publicKeys);
      if (!verified.ok) {
        const classified = classifyRunEvidenceBundle(run, publicKeys).findings.find(
          (finding) => finding.digest === cited.digest,
        );
        findings.push({
          digest: cited.digest,
          mismatchCode: classified?.mismatchCode ?? null,
          comparedField: classified?.comparedField ?? null,
          status: classified?.status ?? 'missing',
        });
        return failed(`cited_run_${verified.reason}`, findings);
      }
      if (
        verified.manifest.context?.chainId !== context.chainId ||
        verified.manifest.context?.escrowAddress.toLowerCase() !==
          context.escrowAddress.toLowerCase()
      )
        return failed('context_mismatch');
      const rules = verified.manifest.rules;
      if (!RISK_RULE_SETS[rules?.version] || ruleSetDigest(rules.version) !== rules.digest)
        return failed('unknown_rules');
      const finding = run.evidence.findings.find((item) => findingDigest(item) === cited.digest);
      if (
        !finding ||
        finding.tradeId !== row.trade_id ||
        !RISK_RULE_SETS[rules.version].contain.includes(finding.mismatchCode)
      )
        return failed('cited_finding_not_verified');
      findings.push({
        digest: cited.digest,
        mismatchCode: finding.mismatchCode,
        comparedField: finding.comparedField,
        status: 'verified',
      });
    }
    if (entry.state === 'RECONCILED_PENDING_APPROVAL') {
      const result = verifyContainmentRecovery(recovery, {
        publicKeys,
        context,
        expectedTradeId: row.trade_id,
        // A display can authenticate historical evidence. Actions check the real clock.
        now: Date.parse(`${latest.completedAt}Z`),
        maxAgeSeconds: 1,
        matchesIncident: (reference) => reference === row.incident_reference,
      });
      if (result.decision !== 'reconciliation_recovery_verified')
        return failed(result.detail ?? result.reason);
    } else if (entry.state !== 'CONTAINED') return failed('incident_state_invalid');
    return { findings, evidence: { status: 'verified', reason: null } };
  } catch {
    return failed('bundle_malformed');
  }
}

module.exports = { verifyContainmentSnapshot };
