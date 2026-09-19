import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeContainmentEvidence } from '../runtime-containment-evidence.mjs';

const secretArn =
  'arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/base-sepolia/wallet-oracle-vGkekr';
const historicalContract = '0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd';

function fixture() {
  return {
    identity: {
      Account: '655177116834',
      Arn: 'arn:aws:sts::655177116834:assumed-role/agroasys-cotsel-terraform-plan-dispatch/GitHubActions',
    },
    services: {
      failures: [],
      services: [
        {
          serviceName: 'cotsel-staging-gateway',
          serviceArn:
            'arn:aws:ecs:ap-south-1:655177116834:service/cotsel-staging/cotsel-staging-gateway',
          clusterArn: 'arn:aws:ecs:ap-south-1:655177116834:cluster/cotsel-staging',
          taskDefinition:
            'arn:aws:ecs:ap-south-1:655177116834:task-definition/cotsel-staging-gateway:21',
          desiredCount: 0,
          runningCount: 0,
          pendingCount: 0,
          enableExecuteCommand: false,
          deployments: [],
        },
      ],
    },
    taskDefinition: {
      taskDefinition: {
        taskDefinitionArn:
          'arn:aws:ecs:ap-south-1:655177116834:task-definition/cotsel-staging-gateway:21',
        family: 'cotsel-staging-gateway',
        revision: 21,
        executionRoleArn: 'arn:aws:iam::655177116834:role/cotsel-staging-gateway-execution',
        taskRoleArn: 'arn:aws:iam::655177116834:role/cotsel-staging-gateway-task',
        registeredAt: '2026-08-25T10:00:00Z',
        containerDefinitions: [
          {
            name: 'gateway',
            image: 'example.invalid/gateway@sha256:abc',
            essential: true,
            environment: [
              { name: 'GATEWAY_ESCROW_ADDRESS', value: historicalContract },
              { name: 'RPC_URL', value: 'https://provider.invalid/reusable-credential' },
            ],
            secrets: [],
            logConfiguration: {
              options: {
                'awslogs-group': '/agroasys/cotsel/staging/gateway',
                'awslogs-stream-prefix': 'gateway',
              },
            },
          },
          {
            name: 'oracle',
            image: 'example.invalid/oracle@sha256:def',
            essential: true,
            environment: [
              { name: 'ESCROW_ADDRESS', value: historicalContract },
              { name: 'ORACLE_SIGNER_CUSTODY_MODE', value: 'raw_private_key' },
            ],
            secrets: [{ name: 'ORACLE_PRIVATE_KEY', valueFrom: secretArn }],
          },
        ],
      },
    },
    runningTaskArns: [],
    pendingTaskArns: [],
    stoppedTasks: {
      tasks: [
        {
          taskArn: 'arn:aws:ecs:ap-south-1:655177116834:task/example',
          taskDefinitionArn:
            'arn:aws:ecs:ap-south-1:655177116834:task-definition/cotsel-staging-gateway:21',
          createdAt: '2026-09-18T13:10:00Z',
          startedAt: '2026-09-18T13:10:10Z',
          stoppedAt: '2026-09-18T13:14:00Z',
          stopCode: 'EssentialContainerExited',
          stoppedReason: 'Essential container in task exited',
          containers: [{ name: 'indexer-pipeline', lastStatus: 'STOPPED', exitCode: 1 }],
        },
      ],
    },
    secretEvents: { Events: [] },
    logGroups: [
      {
        logGroupName: '/agroasys/cotsel/staging/indexer-pipeline',
        events: [
          {
            timestamp: 1_758_200_000_000,
            logStreamName: 'ecs/indexer-pipeline/example',
            message: 'HTTP 429 from https://provider.invalid/reusable-credential',
          },
        ],
      },
    ],
  };
}

const metadata = {
  generatedAt: '2026-09-19T12:00:00Z',
  repository: 'Agroasys/Cotsel',
  commit: 'a'.repeat(40),
  workflow: 'Runtime Containment Evidence',
  runId: '123',
  runAttempt: '1',
  actor: 'Astton',
};

test('builds sanitized fail-closed containment evidence', () => {
  const evidence = buildRuntimeContainmentEvidence(fixture(), metadata);
  assert.equal(evidence.assertions.noRunningOrPendingTasks, true);
  assert.equal(evidence.containment.historicalOracleSecretArn, secretArn);
  assert.equal(evidence.containment.logEvidence[0].events[0].classification, 'rpc_rate_limited');
  assert.match(evidence.containment.logEvidence[0].events[0].messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.containment.taskDefinition.containers[0].environment.RPC_URL, undefined);
  assert.doesNotMatch(JSON.stringify(evidence), /reusable-credential/);
});

test('rejects nonzero service counts and post-containment task starts', () => {
  const running = fixture();
  running.services.services[0].desiredCount = 1;
  assert.throws(
    () => buildRuntimeContainmentEvidence(running, metadata),
    /desired count is not zero/,
  );

  const restarted = fixture();
  restarted.stoppedTasks.tasks[0].startedAt = '2026-09-18T13:16:00Z';
  assert.throws(
    () => buildRuntimeContainmentEvidence(restarted, metadata),
    /started after containment/,
  );
});

test('rejects post-containment Oracle secret retrieval', () => {
  const input = fixture();
  input.secretEvents.Events.push({
    EventId: 'event-id',
    EventName: 'GetSecretValue',
    EventTime: '2026-09-18T13:20:00Z',
    EventSource: 'secretsmanager.amazonaws.com',
    Username: 'cotsel-staging-gateway-execution',
    Resources: [{ ResourceName: secretArn }],
    CloudTrailEvent: JSON.stringify({
      requestParameters: { secretId: secretArn },
      userIdentity: {
        sessionContext: {
          sessionIssuer: {
            arn: 'arn:aws:iam::655177116834:role/cotsel-staging-gateway-execution',
          },
        },
      },
      sourceIPAddress: '192.0.2.1',
      userAgent: 'amazon-ecs-agent',
    }),
  });
  assert.throws(
    () => buildRuntimeContainmentEvidence(input, metadata),
    /retrieved after containment/,
  );
});

test('rejects contract drift and loss of the historical Oracle reference', () => {
  const wrongContract = fixture();
  wrongContract.taskDefinition.taskDefinition.containerDefinitions[0].environment[0].value =
    '0x95021c0fD0C69BB5Cb991832476B646857632e5d';
  assert.throws(
    () => buildRuntimeContainmentEvidence(wrongContract, metadata),
    /conflicting contract bindings/,
  );

  const missingSecret = fixture();
  missingSecret.taskDefinition.taskDefinition.containerDefinitions[1].secrets = [];
  assert.throws(
    () => buildRuntimeContainmentEvidence(missingSecret, metadata),
    /one historical Oracle key reference/,
  );
});
