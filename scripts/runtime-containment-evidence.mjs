#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_ACCOUNT = '655177116834';
const EXPECTED_REGION = 'ap-south-1';
const EXPECTED_SERVICE = 'cotsel-staging-gateway';
const EXPECTED_TASK_DEFINITION = 'cotsel-staging-gateway:21';
const EXPECTED_HISTORICAL_CONTRACT = '0xb594cd561f28dabd771f9b358cf2bc731d14edbd';
const EXPECTED_SECRET_PREFIX =
  'arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/base-sepolia/wallet-oracle-';
const EXPECTED_ROLE_FRAGMENT = 'assumed-role/agroasys-cotsel-terraform-plan-dispatch/';
const CONTAINMENT_BOUNDARY = '2026-09-18T13:15:01.000Z';
const KNOWN_PRE_CONTAINMENT_SECRET_EVENT = '6d59caee-a679-4bd8-ada6-dcb4b7de768c';

const SAFE_ENVIRONMENT_NAMES = new Set([
  'CHAIN_ID',
  'CONTRACT_ADDRESS',
  'ESCROW_ADDRESS',
  'GATEWAY_CHAIN_ID',
  'GATEWAY_CONTRACT_ADDRESS_REQUIRED',
  'GATEWAY_ESCROW_ADDRESS',
  'GATEWAY_GASLESS_EXECUTION_ENABLED',
  'GATEWAY_GASLESS_SIGNER_CUSTODY_MODE',
  'GATEWAY_USDC_ADDRESS',
  'INDEXER_START_BLOCK',
  'ORACLE_ESCROW_ADDRESS',
  'ORACLE_SIGNER_CUSTODY_MODE',
  'RECONCILIATION_ESCROW_ADDRESS',
  'USDC_ADDRESS',
]);

const CONTRACT_ENVIRONMENT_NAMES = new Set([
  'CONTRACT_ADDRESS',
  'ESCROW_ADDRESS',
  'GATEWAY_ESCROW_ADDRESS',
  'ORACLE_ESCROW_ADDRESS',
  'RECONCILIATION_ESCROW_ADDRESS',
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  assert(!Number.isNaN(date.valueOf()), `Invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function hashMessage(message) {
  return createHash('sha256').update(message).digest('hex');
}

function classifyLogMessage(message) {
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return 'rpc_rate_limited';
  if (/no configured rpc endpoint passed chain and block validation/i.test(message)) {
    return 'rpc_endpoint_validation_failed';
  }
  if (/accessdenied|not authorized/i.test(message)) return 'access_denied';
  if (/error|failed|exception/i.test(message)) return 'other_error';
  return 'other';
}

function sanitizeContainers(taskDefinition) {
  return (taskDefinition.containerDefinitions ?? []).map((container) => {
    const safeEnvironment = Object.fromEntries(
      (container.environment ?? [])
        .filter(({ name }) => SAFE_ENVIRONMENT_NAMES.has(name))
        .map(({ name, value }) => [name, value]),
    );

    return {
      name: container.name,
      image: container.image,
      essential: container.essential,
      environment: safeEnvironment,
      secretReferences: (container.secrets ?? []).map(({ name, valueFrom }) => ({
        name,
        valueFrom,
      })),
      logGroup: container.logConfiguration?.options?.['awslogs-group'] ?? null,
      logStreamPrefix: container.logConfiguration?.options?.['awslogs-stream-prefix'] ?? null,
    };
  });
}

function sanitizeStoppedTasks(tasks) {
  return (tasks ?? []).map((task) => ({
    taskArn: task.taskArn,
    taskDefinitionArn: task.taskDefinitionArn,
    createdAt: iso(task.createdAt),
    startedAt: iso(task.startedAt),
    stoppingAt: iso(task.stoppingAt),
    stoppedAt: iso(task.stoppedAt),
    stopCode: task.stopCode ?? null,
    stoppedReason: task.stoppedReason ?? null,
    containers: (task.containers ?? []).map((container) => ({
      name: container.name,
      lastStatus: container.lastStatus,
      exitCode: container.exitCode ?? null,
      reason: container.reason ?? null,
    })),
  }));
}

export function secretArnFromReference(reference) {
  const fields = reference.split(':');
  assert(fields.length >= 7, 'Oracle secret reference is not an ARN');
  return fields.slice(0, 7).join(':');
}

function eventTargetsOracleSecret(event, oracleSecretArn) {
  if (event.EventName !== 'GetSecretValue') return false;
  const detail = JSON.parse(event.CloudTrailEvent ?? '{}');
  const secretId = detail.requestParameters?.secretId ?? '';
  const resourceNames = (event.Resources ?? []).map(({ ResourceName }) => ResourceName ?? '');
  return (
    secretId === oracleSecretArn ||
    secretId.includes('/agroasys/staging/base-sepolia/wallet-oracle') ||
    resourceNames.includes(oracleSecretArn)
  );
}

function sanitizeSecretEvents(events, oracleSecretArn) {
  return (events ?? [])
    .filter((event) => eventTargetsOracleSecret(event, oracleSecretArn))
    .map((event) => {
      const detail = JSON.parse(event.CloudTrailEvent ?? '{}');
      const identity = detail.userIdentity ?? {};
      return {
        eventId: event.EventId,
        eventTime: iso(event.EventTime),
        eventName: event.EventName,
        eventSource: event.EventSource,
        username: event.Username ?? null,
        issuerArn: identity.sessionContext?.sessionIssuer?.arn ?? null,
        invokedBy: identity.invokedBy ?? null,
        userAgentClass: /ecs-agent|fargate/i.test(detail.userAgent ?? '') ? 'ecs-runtime' : 'other',
      };
    });
}

function sanitizeTaskLaunchEvents(events) {
  return (events ?? [])
    .filter((event) => {
      if (!['RunTask', 'StartTask'].includes(event.EventName)) return false;
      const detail = JSON.parse(event.CloudTrailEvent ?? '{}');
      const request = detail.requestParameters ?? {};
      return (
        String(request.taskDefinition ?? '').includes(EXPECTED_TASK_DEFINITION.split(':')[0]) ||
        String(request.group ?? '').includes(EXPECTED_SERVICE)
      );
    })
    .map((event) => {
      const detail = JSON.parse(event.CloudTrailEvent ?? '{}');
      const identity = detail.userIdentity ?? {};
      return {
        eventId: event.EventId,
        eventTime: iso(event.EventTime),
        eventName: event.EventName,
        eventSource: event.EventSource,
        issuerArn: identity.sessionContext?.sessionIssuer?.arn ?? null,
        invokedBy: identity.invokedBy ?? null,
      };
    });
}

function sanitizeLogEvidence(logGroups) {
  return (logGroups ?? []).map((group) => ({
    logGroupName: group.logGroupName,
    events: (group.events ?? []).map((event) => ({
      timestamp: iso(event.timestamp),
      logStreamName: event.logStreamName,
      messageBytes: Buffer.byteLength(event.message ?? ''),
      messageSha256: hashMessage(event.message ?? ''),
      classification: classifyLogMessage(event.message ?? ''),
    })),
  }));
}

export function buildRuntimeContainmentEvidence(input, metadata) {
  const service = input.services?.services?.[0];
  assert(input.identity?.Account === EXPECTED_ACCOUNT, 'AWS account does not match staging');
  assert(
    input.identity?.Arn?.includes(EXPECTED_ROLE_FRAGMENT),
    'Evidence was not collected with the scoped Cotsel plan-dispatch role',
  );
  assert((input.services?.failures ?? []).length === 0, 'ECS service lookup returned failures');
  assert(service?.serviceName === EXPECTED_SERVICE, 'Unexpected ECS service');
  assert(service.desiredCount === 0, 'Gateway desired count is not zero');
  assert(service.runningCount === 0, 'Gateway running count is not zero');
  assert(service.pendingCount === 0, 'Gateway pending count is not zero');
  assert((input.runningTaskArns ?? []).length === 0, 'Gateway has running tasks');
  assert((input.pendingTaskArns ?? []).length === 0, 'Gateway has pending tasks');
  assert(
    service.taskDefinition?.endsWith(`/${EXPECTED_TASK_DEFINITION}`),
    `Gateway no longer references ${EXPECTED_TASK_DEFINITION}`,
  );

  const taskDefinition = input.taskDefinition?.taskDefinition;
  assert(taskDefinition !== null && taskDefinition !== undefined, 'Task definition is missing');
  const containers = sanitizeContainers(taskDefinition);
  const oraclePrivateKeyReferences = containers.flatMap((container) =>
    container.secretReferences
      .filter(({ name }) => name === 'ORACLE_PRIVATE_KEY')
      .map(({ valueFrom }) => valueFrom),
  );
  assert(oraclePrivateKeyReferences.length === 1, 'Expected one historical Oracle key reference');
  const oracleSecretReference = oraclePrivateKeyReferences[0];
  const oracleSecretArn = secretArnFromReference(oracleSecretReference);
  assert(
    oracleSecretArn.startsWith(EXPECTED_SECRET_PREFIX),
    'Historical Oracle secret identity changed unexpectedly',
  );

  const contractBindings = containers.flatMap((container) =>
    Object.entries(container.environment)
      .filter(([name]) => CONTRACT_ENVIRONMENT_NAMES.has(name))
      .map(([name, value]) => ({ container: container.name, name, value })),
  );
  const uniqueContracts = new Set(contractBindings.map(({ value }) => value.toLowerCase()));
  assert(
    uniqueContracts.size === 1,
    'Historical task definition has conflicting contract bindings',
  );
  assert(
    uniqueContracts.has(EXPECTED_HISTORICAL_CONTRACT),
    'Historical AWS contract identity changed before the convergence plan',
  );

  const stoppedTasks = sanitizeStoppedTasks(input.stoppedTasks?.tasks);
  const postContainmentStarts = stoppedTasks.filter(
    ({ startedAt }) => startedAt !== null && startedAt >= CONTAINMENT_BOUNDARY,
  );
  assert(postContainmentStarts.length === 0, 'A gateway task started after containment');

  const taskLaunchEvents = sanitizeTaskLaunchEvents(input.taskLaunchEvents?.Events).filter(
    ({ eventTime }) => eventTime >= CONTAINMENT_BOUNDARY,
  );
  assert(
    taskLaunchEvents.length === 0,
    'CloudTrail recorded a gateway task launch after containment',
  );

  const preContainmentSecretReads = sanitizeSecretEvents(
    input.preContainmentSecretEvents?.Events,
    oracleSecretArn,
  );
  const knownPreContainmentRead = preContainmentSecretReads.find(
    ({ eventId }) => eventId === KNOWN_PRE_CONTAINMENT_SECRET_EVENT,
  );
  assert(
    knownPreContainmentRead !== null && knownPreContainmentRead !== undefined,
    'CloudTrail lookup did not recover the known pre-containment Oracle secret read',
  );

  const secretReads = sanitizeSecretEvents(input.secretEvents?.Events, oracleSecretArn).filter(
    ({ eventTime }) => eventTime >= CONTAINMENT_BOUNDARY,
  );
  assert(secretReads.length === 0, 'Oracle secret was retrieved after containment');

  return {
    schemaVersion: 1,
    evidenceType: 'cotsel.runtime-containment-recheck',
    environment: 'aws-staging',
    generatedAt: metadata.generatedAt,
    source: {
      repository: metadata.repository,
      commit: metadata.commit,
      workflow: metadata.workflow,
      runId: metadata.runId,
      runAttempt: metadata.runAttempt,
      actor: metadata.actor,
      issue: 'https://github.com/Agroasys/Cotsel/issues/667',
    },
    aws: { account: EXPECTED_ACCOUNT, region: EXPECTED_REGION, collectorArn: input.identity.Arn },
    containment: {
      boundary: CONTAINMENT_BOUNDARY,
      preContainmentEvidence:
        'https://github.com/Agroasys/Cotsel/issues/667#issuecomment-5730520636',
      containmentEvidence: 'https://github.com/Agroasys/Cotsel/issues/667#issuecomment-5730559171',
      service: {
        clusterArn: service.clusterArn,
        serviceArn: service.serviceArn,
        desiredCount: service.desiredCount,
        runningCount: service.runningCount,
        pendingCount: service.pendingCount,
        enableExecuteCommand: service.enableExecuteCommand,
        taskDefinition: service.taskDefinition,
        deployments: (service.deployments ?? []).map((deployment) => ({
          id: deployment.id,
          status: deployment.status,
          taskDefinition: deployment.taskDefinition,
          desiredCount: deployment.desiredCount,
          runningCount: deployment.runningCount,
          pendingCount: deployment.pendingCount,
          rolloutState: deployment.rolloutState ?? null,
          createdAt: iso(deployment.createdAt),
          updatedAt: iso(deployment.updatedAt),
        })),
      },
      taskDefinition: {
        arn: taskDefinition.taskDefinitionArn,
        family: taskDefinition.family,
        revision: taskDefinition.revision,
        executionRoleArn: taskDefinition.executionRoleArn,
        taskRoleArn: taskDefinition.taskRoleArn,
        registeredAt: iso(taskDefinition.registeredAt),
        containers,
      },
      historicalOracleSecretReference: oracleSecretReference,
      historicalOracleSecretArn: oracleSecretArn,
      historicalContractBindings: contractBindings,
      stoppedTasks,
      postContainmentTaskLaunchEvents: taskLaunchEvents,
      logEvidence: sanitizeLogEvidence(input.logGroups),
      preContainmentOracleSecretLookupControl: knownPreContainmentRead,
      postContainmentOracleSecretReads: secretReads,
    },
    assertions: {
      serviceScaledToZero: true,
      noRunningOrPendingTasks: true,
      noObservedPostContainmentTaskStarts: true,
      noObservedPostContainmentTaskLaunchEvents: true,
      preContainmentSecretLookupControlRecovered: true,
      noObservedPostContainmentOracleSecretReads: true,
      historicalTaskDefinitionPreserved: true,
      historicalSecretReferencePreserved: true,
      noSecretValuesCollected: true,
    },
    limitations: [
      ...(stoppedTasks.length === 0
        ? [
            'ECS no longer returned the stopped tasks; their reasons remain in the linked pre-containment evidence.',
          ]
        : []),
      'GitHub Actions artifacts are provisional until the approved immutable archive exists.',
      'This evidence proves containment only; it does not prove custody or runtime remediation.',
    ],
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function main() {
  const [inputDirectory, outputFile] = process.argv.slice(2);
  assert(inputDirectory && outputFile, 'Usage: runtime-containment-evidence.mjs INPUT_DIR OUTPUT');
  const read = (name) => readJson(path.join(inputDirectory, name));
  const input = {
    identity: read('identity.json'),
    services: read('services.json'),
    taskDefinition: read('task-definition.json'),
    runningTaskArns: read('running-tasks.json').taskArns ?? [],
    pendingTaskArns: read('pending-tasks.json').taskArns ?? [],
    stoppedTasks: read('stopped-tasks.json'),
    taskLaunchEvents: read('task-launch-events.json'),
    preContainmentSecretEvents: read('pre-containment-secret-events.json'),
    secretEvents: read('secret-events.json'),
    logGroups: read('log-events.json'),
  };
  const metadata = {
    generatedAt: new Date().toISOString(),
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    workflow: process.env.GITHUB_WORKFLOW,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    actor: process.env.GITHUB_TRIGGERING_ACTOR,
  };
  const evidence = buildRuntimeContainmentEvidence(input, metadata);
  writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
