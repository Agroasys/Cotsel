import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGatewayDeadLetterArgs, runGatewayDeadLetterWorkflow } from '../lib/gateway-dead-letter-workflow-lib.mjs';

test('parseGatewayDeadLetterArgs defaults list to open failures', () => {
  assert.deepEqual(parseGatewayDeadLetterArgs(['list']), {
    command: 'list',
    json: false,
    state: 'open',
  });
});

test('runGatewayDeadLetterWorkflow lists records as JSON', async () => {
  const lines = [];
  const result = await runGatewayDeadLetterWorkflow(
    ['list', '--json'],
    {
      async listFailedOperations() {
        return [{
          failedOperationId: 'failed-op-1',
          failureState: 'open',
          operationType: 'compliance.create_decision',
          targetService: 'gateway_compliance_write',
          retryCount: 1,
          lastFailedAt: '2026-03-26T18:00:00.000Z',
        }];
      },
      async replayFailedOperation() {
        throw new Error('not used');
      },
    },
    {
      log: (line) => lines.push(line),
    },
  );

  assert.equal(result.success, true);
  assert.equal(JSON.parse(lines[0]).data[0].failedOperationId, 'failed-op-1');
});

test('runGatewayDeadLetterWorkflow replays a failed operation deterministically', async () => {
  const lines = [];
  const result = await runGatewayDeadLetterWorkflow(
    ['replay', 'failed-op-2', '--json'],
    {
      async listFailedOperations() {
        throw new Error('not used');
      },
      async replayFailedOperation(failedOperationId) {
        assert.equal(failedOperationId, 'failed-op-2');
        return {
          failedOperationId,
          failureState: 'replayed',
          lastReplayedAt: '2026-03-26T18:05:00.000Z',
        };
      },
    },
    {
      log: (line) => lines.push(line),
    },
  );

  assert.equal(result.success, true);
  assert.equal(JSON.parse(lines[0]).data.failureState, 'replayed');
});

console.log('gateway-dead-letter-workflow test: pass');
