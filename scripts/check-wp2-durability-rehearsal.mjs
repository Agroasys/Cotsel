#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCandidateBindable,
  canonicalize,
  candidateIdentityDigest,
  readCandidateManifest,
  validateCandidateManifest,
} from './check-release-evidence-binding.mjs';

export const REQUIRED_SCENARIOS = [
  'before_dequeue',
  'active_lease_worker_crash',
  'during_signing',
  'immediately_after_broadcast',
  'during_confirmation',
  'duplicate_delivery',
  'expired_lease_reclaim',
  'poison_dead_letter',
  'operator_redrive',
  'overload_backpressure',
  'callback_lease_reclaim',
];

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const AWS_ACCOUNT_ID = /^[0-9]{12}$/;
const TASK_DEFINITION =
  /^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_./-]+:[1-9][0-9]*$/;
const TASK_ARN = /^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task\/[A-Za-z0-9_./-]+$/;
const ACTOR = /^[a-z0-9][a-z0-9._@/+-]{1,63}$/;
const TERMINAL_OR_OWNED = new Set(['completed', 'dead_letter', 'outcome_pending']);
const RECONCILIATION_RESULTS = new Set(['matched', 'owned_exception', 'not_applicable']);

function fail(message) {
  throw new Error(`WP-2 durability rehearsal invalid: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function timestamp(value, label) {
  string(value, label);
  if (Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO date-time`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function array(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${label} must contain at least ${minimum} item(s)`);
  }
  return value;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the candidate manifest`);
}

function observation(scenario, name) {
  if (!(name in scenario.observations)) fail(`${scenario.id}.observations.${name} is required`);
  return scenario.observations[name];
}

function observedInteger(scenario, name, minimum = 0) {
  return integer(observation(scenario, name), `${scenario.id}.observations.${name}`, minimum);
}

function observedBoolean(scenario, name) {
  return boolean(observation(scenario, name), `${scenario.id}.observations.${name}`);
}

function requireAtMost(scenario, name, maximum) {
  const value = observedInteger(scenario, name);
  if (value > maximum) fail(`${scenario.id}.observations.${name} must be at most ${maximum}`);
}

function requireExactly(scenario, name, expected) {
  const value = observedInteger(scenario, name);
  if (value !== expected) fail(`${scenario.id}.observations.${name} must equal ${expected}`);
}

function requireOneAcceptedDurableCommand(scenario) {
  requireExactly(scenario, 'acceptedCommandCount', 1);
  requireExactly(scenario, 'durableCommandCount', 1);
}

function validateCommonScenario(scenario) {
  object(scenario, 'scenario');
  string(scenario.id, 'scenario.id');
  timestamp(scenario.startedAt, `${scenario.id}.startedAt`);
  timestamp(scenario.completedAt, `${scenario.id}.completedAt`);
  if (Date.parse(scenario.completedAt) < Date.parse(scenario.startedAt)) {
    fail(`${scenario.id}.completedAt precedes startedAt`);
  }
  array(scenario.evidenceRefs, `${scenario.id}.evidenceRefs`, 2).forEach((reference, index) => {
    string(reference, `${scenario.id}.evidenceRefs[${index}]`);
  });
  object(scenario.observations, `${scenario.id}.observations`);
  requireExactly(scenario, 'lostAcceptedCommandCount', 0);
  requireAtMost(scenario, 'financialEffectCount', 1);
  requireAtMost(scenario, 'broadcastAttemptCount', 1);
  requireAtMost(scenario, 'distinctTransactionHashCount', 1);
  requireAtMost(scenario, 'maxConcurrentLeaseOwners', 1);
  requireExactly(scenario, 'staleOwnerUpdateCount', 0);
  if (!observedBoolean(scenario, 'operatorVisible')) {
    fail(`${scenario.id}.observations.operatorVisible must be true`);
  }
  const reconciliationResult = string(
    observation(scenario, 'reconciliationResult'),
    `${scenario.id}.observations.reconciliationResult`,
  );
  if (!RECONCILIATION_RESULTS.has(reconciliationResult)) {
    fail(`${scenario.id}.observations.reconciliationResult is invalid`);
  }
  const finalState = string(
    observation(scenario, 'finalState'),
    `${scenario.id}.observations.finalState`,
  );
  if (!TERMINAL_OR_OWNED.has(finalState)) {
    fail(`${scenario.id}.observations.finalState is not terminal or owned`);
  }
}

function validateScenarioInvariants(scenario) {
  switch (scenario.id) {
    case 'before_dequeue':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'replacementWorkerClaimCount', 1);
      break;
    case 'active_lease_worker_crash':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'expiredLeaseReclaimCount', 1);
      requireExactly(scenario, 'replacementWorkerClaimCount', 1);
      break;
    case 'during_signing':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'replacementWorkerClaimCount', 1);
      requireAtMost(scenario, 'broadcastAttemptCount', 1);
      break;
    case 'immediately_after_broadcast':
    case 'during_confirmation':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'distinctTransactionHashCount', 1);
      requireExactly(scenario, 'broadcastAttemptCount', 1);
      requireExactly(scenario, 'rebroadcastAfterRestartCount', 0);
      break;
    case 'duplicate_delivery':
      requireOneAcceptedDurableCommand(scenario);
      observedInteger(scenario, 'duplicateSubmissionCount', 1);
      break;
    case 'expired_lease_reclaim':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'expiredLeaseReclaimCount', 1);
      requireExactly(scenario, 'replacementWorkerClaimCount', 1);
      break;
    case 'poison_dead_letter':
      requireOneAcceptedDurableCommand(scenario);
      requireExactly(scenario, 'deadLetterCount', 1);
      observedInteger(scenario, 'attemptHistoryCount', 1);
      requireExactly(scenario, 'broadcastAttemptCount', 0);
      requireExactly(scenario, 'financialEffectCount', 0);
      if (scenario.observations.finalState !== 'dead_letter') {
        fail('poison_dead_letter must finish in dead_letter');
      }
      break;
    case 'operator_redrive':
      requireOneAcceptedDurableCommand(scenario);
      if (!observedBoolean(scenario, 'operatorAuthorized')) {
        fail('operator_redrive must record operator authorization');
      }
      if (!observedBoolean(scenario, 'operatorAuditRecorded')) {
        fail('operator_redrive must record the operator audit event');
      }
      requireExactly(scenario, 'preRedriveTransactionHashCount', 0);
      requireExactly(scenario, 'redriveCount', 1);
      requireExactly(scenario, 'additionalAttemptCount', 1);
      break;
    case 'overload_backpressure':
      observedInteger(scenario, 'acceptedCommandCount', 1);
      requireExactly(scenario, 'durableCommandCount', scenario.observations.acceptedCommandCount);
      observedInteger(scenario, 'backpressureRejectedCount', 1);
      if (!observedBoolean(scenario, 'intakeFailedClosed')) {
        fail('overload_backpressure must fail intake closed');
      }
      break;
    case 'callback_lease_reclaim':
      if (!observedBoolean(scenario, 'stableEventIdPreserved')) {
        fail('callback_lease_reclaim must preserve the stable event ID');
      }
      requireExactly(scenario, 'expiredLeaseReclaimCount', 1);
      requireExactly(scenario, 'receiverEffectCount', 1);
      observedInteger(scenario, 'deliveryAttemptCount', 2);
      break;
    default:
      fail(`unknown scenario ${scenario.id}`);
  }
}

function validateRuntime(runtime, manifest) {
  object(runtime, 'runtime');
  requireEqual(
    string(runtime.environment, 'runtime.environment'),
    manifest.environment.name,
    'runtime.environment',
  );
  requireEqual(
    string(runtime.sourceCommit, 'runtime.sourceCommit'),
    manifest.source.commit,
    'runtime.sourceCommit',
  );
  string(runtime.awsAccountId, 'runtime.awsAccountId', AWS_ACCOUNT_ID);
  string(runtime.region, 'runtime.region');
  string(runtime.cluster, 'runtime.cluster');
  string(runtime.service, 'runtime.service');
  string(runtime.taskDefinition, 'runtime.taskDefinition', TASK_DEFINITION);
  if (
    !runtime.taskDefinition.includes(`:${runtime.region}:${runtime.awsAccountId}:task-definition/`)
  ) {
    fail('runtime.taskDefinition does not match the reported AWS account and region');
  }
  array(runtime.taskArns, 'runtime.taskArns', 2).forEach((taskArn, index) => {
    string(taskArn, `runtime.taskArns[${index}]`, TASK_ARN);
    if (!taskArn.includes(`:${runtime.region}:${runtime.awsAccountId}:task/${runtime.cluster}/`)) {
      fail(`runtime.taskArns[${index}] does not match the reported account, region, and cluster`);
    }
  });
  string(runtime.imageDigest, 'runtime.imageDigest', IMAGE_DIGEST);
  const gatewayArtifact = manifest.artifacts.find(
    (artifact) => artifact.name === 'gateway' && artifact.kind === 'container-image',
  );
  if (!gatewayArtifact) fail('candidate manifest has no gateway container image');
  requireEqual(runtime.imageDigest, gatewayArtifact.digest, 'runtime.imageDigest');
  string(runtime.migrationHeadIdentity, 'runtime.migrationHeadIdentity');
  const gatewayMigration = manifest.migrations.find(
    (migration) => migration.component.toLowerCase() === 'gateway',
  );
  if (!gatewayMigration) fail('candidate manifest has no Gateway migration identity');
  requireEqual(
    runtime.migrationHeadIdentity,
    gatewayMigration.headIdentity,
    'runtime.migrationHeadIdentity',
  );
  requireEqual(
    string(runtime.migrationChecksumSha256, 'runtime.migrationChecksumSha256', SHA256),
    gatewayMigration.checksumSha256,
    'runtime.migrationChecksumSha256',
  );
  requireEqual(
    integer(runtime.chainId, 'runtime.chainId', 1),
    manifest.chain.chainId,
    'runtime.chainId',
  );
  if (runtime.chainId !== 84532) fail('runtime.chainId must be Base Sepolia 84532');
  requireEqual(
    string(runtime.contractAddress, 'runtime.contractAddress').toLowerCase(),
    manifest.contract.address.toLowerCase(),
    'runtime.contractAddress',
  );
  requireEqual(
    string(runtime.configDigestSha256, 'runtime.configDigestSha256', SHA256),
    manifest.configDigest.sha256,
    'runtime.configDigestSha256',
  );
  if (canonicalize(runtime.providerMode) !== canonicalize(manifest.providerMode)) {
    fail('runtime.providerMode does not match the candidate manifest');
  }
}

export function validateWp2DurabilityRehearsal(report, manifest) {
  validateCandidateManifest(manifest);
  assertCandidateBindable(manifest);
  object(report, 'report');
  if (report.schemaVersion !== 'cotsel.wp2-durability-rehearsal.v1') {
    fail('schemaVersion must be cotsel.wp2-durability-rehearsal.v1');
  }
  requireEqual(string(report.candidateId, 'candidateId'), manifest.candidateId, 'candidateId');
  requireEqual(
    string(report.manifestSha256, 'manifestSha256', SHA256),
    candidateIdentityDigest(manifest),
    'manifestSha256',
  );
  string(report.runId, 'runId');
  timestamp(report.startedAt, 'startedAt');
  timestamp(report.completedAt, 'completedAt');
  if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
    fail('completedAt precedes startedAt');
  }
  string(report.producedBy, 'producedBy', ACTOR);
  if (!Array.isArray(report.blockers)) fail('blockers must be an array');
  if (report.blockers.length > 0) fail('blockers must be empty before the report can pass');
  validateRuntime(report.runtime, manifest);

  const scenarios = array(report.scenarios, 'scenarios');
  const scenarioIds = scenarios.map((scenario) => scenario?.id);
  for (const required of REQUIRED_SCENARIOS) {
    if (scenarioIds.filter((id) => id === required).length !== 1) {
      fail(`scenario ${required} must occur exactly once`);
    }
  }
  if (new Set(scenarioIds).size !== scenarios.length) fail('scenario IDs must be unique');
  if (scenarios.length !== REQUIRED_SCENARIOS.length) fail('unexpected scenarios are not allowed');

  for (const scenario of scenarios) {
    validateCommonScenario(scenario);
    validateScenarioInvariants(scenario);
  }
  return report;
}

function parseCli(argv) {
  const options = { manifest: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--manifest' || flag === '--report') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`${flag} requires a path`);
      options[flag.slice(2)] = value;
    } else {
      fail(`unknown option ${flag}`);
    }
  }
  if (!options.manifest || !options.report) fail('--manifest and --report are required');
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const manifest = readCandidateManifest(path.resolve(options.manifest));
  const report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf8'));
  validateWp2DurabilityRehearsal(report, manifest);
  console.log(`WP-2 durability rehearsal valid: ${report.runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
