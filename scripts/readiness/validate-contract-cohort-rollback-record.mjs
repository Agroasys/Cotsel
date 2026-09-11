import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/;
const BASE_UNITS = /^(?:0|[1-9][0-9]*)$/;
const REQUIRED_APPROVAL_ROLES = ['Protocol', 'Finance', 'Operations', 'Release'];
const DECISIONS = new Set(['stop_intake', 'rollback', 'dual_cohort', 'forward_fix']);

function object(value, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} is required`);
  return value;
}

function text(value, name) {
  assert.ok(typeof value === 'string' && value.trim(), `${name} is required`);
  return value.trim();
}

function timestamp(value, name) {
  const normalized = text(value, name);
  assert.ok(Number.isFinite(Date.parse(normalized)), `${name} must be an ISO timestamp`);
  return normalized;
}

function digest(value, name) {
  const normalized = text(value, name);
  assert.match(normalized, SHA256, `${name} must be a SHA-256 digest`);
  return normalized;
}

function validateContract(contract, name) {
  object(contract, name);
  assert.match(text(contract.address, `${name}.address`), ADDRESS, `${name}.address is invalid`);
  assert.ok(
    Number.isInteger(contract.chainId) && contract.chainId > 0,
    `${name}.chainId is invalid`,
  );
  assert.ok(
    Number.isInteger(contract.deploymentBlock) && contract.deploymentBlock > 0,
    `${name}.deploymentBlock is invalid`,
  );
  digest(contract.abiSha256, `${name}.abiSha256`);
  digest(contract.bytecodeSha256, `${name}.bytecodeSha256`);
  digest(contract.applicationDigest, `${name}.applicationDigest`);
  digest(contract.indexerDigest, `${name}.indexerDigest`);
  assert.ok(
    Number.isInteger(contract.activeTradeCount) && contract.activeTradeCount >= 0,
    `${name}.activeTradeCount is invalid`,
  );
  assert.match(
    text(contract.usdcExposureBaseUnits, `${name}.usdcExposureBaseUnits`),
    BASE_UNITS,
    `${name}.usdcExposureBaseUnits must be an unsigned base-unit value`,
  );
  assert.ok(
    Number.isInteger(contract.exposureAsOfBlock) && contract.exposureAsOfBlock > 0,
    `${name}.exposureAsOfBlock is invalid`,
  );
  text(contract.exposureEvidence, `${name}.exposureEvidence`);
}

function validateApprovals(approvals, resumptionAuthorized) {
  assert.ok(Array.isArray(approvals), 'approvals must be an array');
  assert.equal(
    new Set(approvals.map((approval) => approval.role)).size,
    approvals.length,
    'approval roles must be unique',
  );

  for (const role of REQUIRED_APPROVAL_ROLES) {
    const approval = approvals.find((candidate) => candidate.role === role);
    assert.ok(approval, `${role} approval is required`);
    text(approval.identity, `${role} approval identity`);
    assert.ok(
      ['pending', 'approved', 'rejected'].includes(approval.decision),
      `${role} decision is invalid`,
    );
    if (approval.decision !== 'pending') {
      timestamp(approval.decidedAt, `${role} approval decidedAt`);
      text(approval.evidence, `${role} approval evidence`);
    }
    if (resumptionAuthorized) {
      assert.equal(approval.decision, 'approved', `${role} must approve resumption`);
    }
  }
}

export function validateContractCohortRollbackRecord(record) {
  object(record, 'record');
  assert.equal(
    record.schemaVersion,
    'cotsel.contract-cohort-rollback.v1',
    'schemaVersion is invalid',
  );
  text(record.recordId, 'recordId');
  text(record.incidentReference, 'incidentReference');
  text(record.environment, 'environment');

  const manifest = object(record.releaseManifest, 'releaseManifest');
  text(manifest.candidateId, 'releaseManifest.candidateId');
  digest(manifest.sha256, 'releaseManifest.sha256');

  const decision = object(record.decision, 'decision');
  assert.ok(DECISIONS.has(decision.action), 'decision.action is invalid');
  text(decision.owner, 'decision.owner');
  timestamp(decision.decidedAt, 'decision.decidedAt');
  text(decision.rationale, 'decision.rationale');

  const contracts = object(record.contracts, 'contracts');
  validateContract(contracts.current, 'contracts.current');
  validateContract(contracts.rollback, 'contracts.rollback');
  assert.equal(
    contracts.current.chainId,
    contracts.rollback.chainId,
    'contract chain IDs must match',
  );
  assert.notEqual(
    contracts.current.address.toLowerCase(),
    contracts.rollback.address.toLowerCase(),
    'current and rollback addresses must differ',
  );

  const controls = object(record.controls, 'controls');
  assert.equal(controls.intakeStopped, true, 'new intake must be stopped');
  assert.equal(controls.promotionDisabled, true, 'promotion must be disabled');
  assert.equal(controls.logsPreserved, true, 'logs must be preserved');
  for (const field of [
    'addressQualifiedIndexing',
    'independentReconciliation',
    'perAddressMonitoring',
  ]) {
    assert.equal(typeof controls[field], 'boolean', `controls.${field} must be boolean`);
  }

  const compatibility = object(record.compatibility, 'compatibility');
  timestamp(compatibility.windowStartsAt, 'compatibility.windowStartsAt');
  timestamp(compatibility.windowEndsAt, 'compatibility.windowEndsAt');
  assert.ok(
    Date.parse(compatibility.windowEndsAt) > Date.parse(compatibility.windowStartsAt),
    'compatibility window must end after it starts',
  );
  assert.ok(Array.isArray(compatibility.knownLimits), 'compatibility.knownLimits must be an array');

  if (decision.action === 'dual_cohort') {
    assert.equal(
      controls.addressQualifiedIndexing,
      true,
      'dual-cohort indexing must be address-qualified',
    );
    assert.equal(
      controls.independentReconciliation,
      true,
      'dual-cohort reconciliation must be independent',
    );
    assert.equal(
      controls.perAddressMonitoring,
      true,
      'dual-cohort monitoring must cover each address',
    );
  }

  const reconciliation = object(record.reconciliation, 'reconciliation');
  assert.ok(
    Number.isInteger(reconciliation.pendingUnknownTransactions) &&
      reconciliation.pendingUnknownTransactions >= 0,
    'reconciliation.pendingUnknownTransactions is invalid',
  );
  assert.match(
    text(
      reconciliation.unexplainedExposureBaseUnits,
      'reconciliation.unexplainedExposureBaseUnits',
    ),
    BASE_UNITS,
    'reconciliation.unexplainedExposureBaseUnits must be an unsigned base-unit value',
  );
  assert.ok(
    Array.isArray(reconciliation.evidence) && reconciliation.evidence.length > 0,
    'reconciliation evidence is required',
  );
  reconciliation.evidence.forEach((entry, index) =>
    text(entry, `reconciliation.evidence[${index}]`),
  );

  assert.equal(
    typeof record.resumptionAuthorized,
    'boolean',
    'resumptionAuthorized must be boolean',
  );
  validateApprovals(record.approvals, record.resumptionAuthorized);

  assert.ok(Array.isArray(record.evidence) && record.evidence.length > 0, 'evidence is required');
  record.evidence.forEach((entry, index) => text(entry, `evidence[${index}]`));

  if (record.resumptionAuthorized) {
    assert.equal(
      reconciliation.pendingUnknownTransactions,
      0,
      'unknown transactions block resumption',
    );
    assert.equal(
      reconciliation.unexplainedExposureBaseUnits,
      '0',
      'unexplained exposure blocks resumption',
    );
    assert.equal(controls.addressQualifiedIndexing, true, 'address-qualified indexing is required');
    assert.equal(
      controls.independentReconciliation,
      true,
      'independent reconciliation is required',
    );
    assert.equal(controls.perAddressMonitoring, true, 'per-address monitoring is required');
  }

  return record;
}

async function main() {
  const recordPath = process.argv[2];
  assert.ok(
    recordPath,
    'usage: node scripts/readiness/validate-contract-cohort-rollback-record.mjs <record.json>',
  );
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  validateContractCohortRollbackRecord(record);
  process.stdout.write(`Valid contract-cohort rollback record: ${record.recordId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
