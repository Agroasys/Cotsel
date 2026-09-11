import assert from 'node:assert/strict';
import test from 'node:test';

import { validateContractCohortRollbackRecord } from './validate-contract-cohort-rollback-record.mjs';

const NOW = '2026-09-10T08:00:00.000Z';
const LATER = '2026-09-11T08:00:00.000Z';

function contractFixture(address, fill) {
  return {
    address,
    chainId: 84532,
    deploymentBlock: 45914609,
    abiSha256: fill.repeat(64),
    bytecodeSha256: fill.repeat(64),
    applicationDigest: `sha256:${fill.repeat(64)}`,
    indexerDigest: `sha256:${fill.repeat(64)}`,
    activeTradeCount: 0,
    usdcExposureBaseUnits: '0',
    exposureAsOfBlock: 45915000,
    exposureEvidence: `evidence://${fill}/exposure`,
  };
}

function recordFixture() {
  return {
    schemaVersion: 'cotsel.contract-cohort-rollback.v1',
    recordId: 'rollback-test-001',
    incidentReference: 'INC-001',
    environment: 'base-sepolia-staging',
    releaseManifest: {
      candidateId: 'cotsel-candidate-test',
      sha256: 'a'.repeat(64),
    },
    decision: {
      action: 'forward_fix',
      owner: 'Protocol Owner',
      decidedAt: NOW,
      rationale: 'Keep intake stopped while the current release is corrected.',
    },
    contracts: {
      current: contractFixture('0x1111111111111111111111111111111111111111', 'b'),
      rollback: contractFixture('0x2222222222222222222222222222222222222222', 'c'),
    },
    controls: {
      intakeStopped: true,
      promotionDisabled: true,
      logsPreserved: true,
      addressQualifiedIndexing: false,
      independentReconciliation: false,
      perAddressMonitoring: false,
    },
    compatibility: {
      windowStartsAt: NOW,
      windowEndsAt: LATER,
      knownLimits: ['The current indexer supports one contract address.'],
    },
    reconciliation: {
      pendingUnknownTransactions: 0,
      unexplainedExposureBaseUnits: '0',
      evidence: ['evidence://reconciliation/current-and-rollback'],
    },
    resumptionAuthorized: false,
    approvals: ['Protocol', 'Finance', 'Operations', 'Release'].map((role) => ({
      role,
      identity: `${role.toLowerCase()}-owner`,
      decision: 'pending',
    })),
    evidence: ['evidence://manifest', 'evidence://logs'],
  };
}

test('accepts a contained forward-fix record without claiming resumption', () => {
  assert.doesNotThrow(() => validateContractCohortRollbackRecord(recordFixture()));
});

test('rejects a record that does not stop new intake', () => {
  const record = recordFixture();
  record.controls.intakeStopped = false;
  assert.throws(() => validateContractCohortRollbackRecord(record), /new intake must be stopped/);
});

test('rejects a rollback address that equals the current address', () => {
  const record = recordFixture();
  record.contracts.rollback.address = record.contracts.current.address;
  assert.throws(() => validateContractCohortRollbackRecord(record), /addresses must differ/);
});

test('rejects dual-cohort operation without address-qualified coverage', () => {
  const record = recordFixture();
  record.decision.action = 'dual_cohort';
  assert.throws(
    () => validateContractCohortRollbackRecord(record),
    /indexing must be address-qualified/,
  );
});

test('rejects resumption while unexplained exposure remains', () => {
  const record = recordFixture();
  record.resumptionAuthorized = true;
  record.controls.addressQualifiedIndexing = true;
  record.controls.independentReconciliation = true;
  record.controls.perAddressMonitoring = true;
  record.reconciliation.unexplainedExposureBaseUnits = '1';
  record.approvals = record.approvals.map((approval) => ({
    ...approval,
    decision: 'approved',
    decidedAt: NOW,
    evidence: `evidence://${approval.role.toLowerCase()}/approval`,
  }));
  assert.throws(
    () => validateContractCohortRollbackRecord(record),
    /unexplained exposure blocks resumption/,
  );
});

test('rejects resumption without every required approval', () => {
  const record = recordFixture();
  record.resumptionAuthorized = true;
  record.controls.addressQualifiedIndexing = true;
  record.controls.independentReconciliation = true;
  record.controls.perAddressMonitoring = true;
  assert.throws(
    () => validateContractCohortRollbackRecord(record),
    /Protocol must approve resumption/,
  );
});
