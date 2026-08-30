import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateIdentityDigest } from '../check-release-evidence-binding.mjs';
import {
  REQUIRED_SCENARIOS,
  validateWp2DurabilityRehearsal,
} from '../check-wp2-durability-rehearsal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_MANIFEST = path.join(
  ROOT,
  'scripts/tests/fixtures/release-evidence/candidate-manifest.json',
);

function candidateManifest() {
  const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, 'utf8'));
  manifest.migrations.push({
    component: 'gateway',
    headIdentity: '005_gasless_durable_commands',
    checksumSha256: 'a'.repeat(64),
  });
  return manifest;
}

function commonObservations() {
  return {
    lostAcceptedCommandCount: 0,
    financialEffectCount: 1,
    broadcastAttemptCount: 1,
    distinctTransactionHashCount: 1,
    maxConcurrentLeaseOwners: 1,
    staleOwnerUpdateCount: 0,
    operatorVisible: true,
    reconciliationResult: 'matched',
    finalState: 'completed',
  };
}

function acceptedCommandObservations() {
  return { acceptedCommandCount: 1, durableCommandCount: 1 };
}

function observationsFor(id) {
  const common = commonObservations();
  switch (id) {
    case 'before_dequeue':
      return {
        ...common,
        ...acceptedCommandObservations(),
        replacementWorkerClaimCount: 1,
      };
    case 'active_lease_worker_crash':
      return {
        ...common,
        ...acceptedCommandObservations(),
        expiredLeaseReclaimCount: 1,
        replacementWorkerClaimCount: 1,
      };
    case 'during_signing':
      return { ...common, ...acceptedCommandObservations(), replacementWorkerClaimCount: 1 };
    case 'immediately_after_broadcast':
    case 'during_confirmation':
      return { ...common, ...acceptedCommandObservations(), rebroadcastAfterRestartCount: 0 };
    case 'duplicate_delivery':
      return { ...common, ...acceptedCommandObservations(), duplicateSubmissionCount: 1 };
    case 'expired_lease_reclaim':
      return {
        ...common,
        ...acceptedCommandObservations(),
        expiredLeaseReclaimCount: 1,
        replacementWorkerClaimCount: 1,
      };
    case 'poison_dead_letter':
      return {
        ...common,
        ...acceptedCommandObservations(),
        finalState: 'dead_letter',
        reconciliationResult: 'owned_exception',
        financialEffectCount: 0,
        broadcastAttemptCount: 0,
        distinctTransactionHashCount: 0,
        deadLetterCount: 1,
        attemptHistoryCount: 5,
      };
    case 'operator_redrive':
      return {
        ...common,
        ...acceptedCommandObservations(),
        operatorAuthorized: true,
        operatorAuditRecorded: true,
        preRedriveTransactionHashCount: 0,
        redriveCount: 1,
        additionalAttemptCount: 1,
      };
    case 'overload_backpressure':
      return {
        ...common,
        ...acceptedCommandObservations(),
        backpressureRejectedCount: 1,
        intakeFailedClosed: true,
      };
    case 'callback_lease_reclaim':
      return {
        ...common,
        broadcastAttemptCount: 0,
        distinctTransactionHashCount: 0,
        stableEventIdPreserved: true,
        expiredLeaseReclaimCount: 1,
        receiverEffectCount: 1,
        deliveryAttemptCount: 2,
      };
    default:
      throw new Error(`missing fixture for ${id}`);
  }
}

function validReport(manifest = candidateManifest()) {
  return {
    schemaVersion: 'cotsel.wp2-durability-rehearsal.v1',
    candidateId: manifest.candidateId,
    manifestSha256: candidateIdentityDigest(manifest),
    runId: 'wp2-staging-20260830-001',
    startedAt: '2026-08-30T06:00:00.000Z',
    completedAt: '2026-08-30T08:00:00.000Z',
    producedBy: 'astton',
    blockers: [],
    runtime: {
      environment: manifest.environment.name,
      sourceCommit: manifest.source.commit,
      awsAccountId: '655177116834',
      region: 'ap-south-1',
      cluster: 'cotsel-staging',
      service: 'cotsel-staging-gateway',
      taskDefinition:
        'arn:aws:ecs:ap-south-1:655177116834:task-definition/cotsel-staging-gateway:42',
      taskArns: [
        'arn:aws:ecs:ap-south-1:655177116834:task/cotsel-staging/11111111111111111111111111111111',
        'arn:aws:ecs:ap-south-1:655177116834:task/cotsel-staging/22222222222222222222222222222222',
      ],
      imageDigest: manifest.artifacts.find((artifact) => artifact.name === 'gateway').digest,
      migrationHeadIdentity: '005_gasless_durable_commands',
      migrationChecksumSha256: 'a'.repeat(64),
      chainId: manifest.chain.chainId,
      contractAddress: manifest.contract.address,
      configDigestSha256: manifest.configDigest.sha256,
      providerMode: { ...manifest.providerMode },
    },
    scenarios: REQUIRED_SCENARIOS.map((id, index) => ({
      id,
      startedAt: `2026-08-30T06:${String(index).padStart(2, '0')}:00.000Z`,
      completedAt: `2026-08-30T06:${String(index).padStart(2, '0')}:30.000Z`,
      evidenceRefs: [`cloudwatch:${id}:logs`, `postgres:${id}:redacted-query`],
      observations: observationsFor(id),
    })),
  };
}

function scenario(report, id) {
  return report.scenarios.find((entry) => entry.id === id);
}

test('accepts a complete candidate-bound WP-2 rehearsal report', () => {
  const manifest = candidateManifest();
  assert.equal(
    validateWp2DurabilityRehearsal(validReport(manifest), manifest).runId,
    'wp2-staging-20260830-001',
  );
});

test('rejects a rehearsal with a missing required scenario', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  report.scenarios = report.scenarios.filter((entry) => entry.id !== 'during_signing');
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /scenario during_signing must occur exactly once/,
  );
});

test('rejects evidence bound to another source commit', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  report.runtime.sourceCommit = 'b'.repeat(40);
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /runtime.sourceCommit does not match/,
  );
});

test('rejects an after-broadcast restart that rebroadcasts', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  scenario(report, 'immediately_after_broadcast').observations.rebroadcastAfterRestartCount = 1;
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /rebroadcastAfterRestartCount must equal 0/,
  );
});

test('rejects any lost accepted command', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  scenario(report, 'active_lease_worker_crash').observations.lostAcceptedCommandCount = 1;
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /lostAcceptedCommandCount must equal 0/,
  );
});

test('rejects a poison command that produces a financial effect', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  scenario(report, 'poison_dead_letter').observations.financialEffectCount = 1;
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /financialEffectCount must equal 0/,
  );
});

test('rejects an unaudited operator redrive', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  scenario(report, 'operator_redrive').observations.operatorAuditRecorded = false;
  assert.throws(
    () => validateWp2DurabilityRehearsal(report, manifest),
    /must record the operator audit event/,
  );
});

test('rejects a report that carries unresolved blockers', () => {
  const manifest = candidateManifest();
  const report = validReport(manifest);
  report.blockers.push('notification delivery was not observed');
  assert.throws(() => validateWp2DurabilityRehearsal(report, manifest), /blockers must be empty/);
});
