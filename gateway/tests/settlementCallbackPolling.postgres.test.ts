/** SPDX-License-Identifier: Apache-2.0 */
import { fork } from 'child_process';
import path from 'path';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { createPostgresSettlementStore } from '../src/core/settlementStore';
import { SettlementService } from '../src/core/settlementService';
import { baseTestGatewayConfig } from './support/testConfig';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

describePostgres('scheduled callback failure containment', () => {
  jest.setTimeout(60_000);
  test('keeps Gateway alive while repeated invalid outbox polls hold every delivery lease', async () => {
    const db = await createUserActionEnginePostgres();
    try {
      const store = createPostgresSettlementStore(db.runtime);
      const service = new SettlementService(
        {
          ...baseTestGatewayConfig,
          settlementCallbackEnabled: true,
          settlementCallbackUrl: 'http://127.0.0.1:1/unused-callback',
          settlementCallbackApiKey: 'fixture-key',
          settlementCallbackApiSecret: 'fixture-secret',
        },
        store,
      );
      const handoff = await service.createHandoff({
        platformId: 'polling-test',
        platformHandoffId: 'invalid-poll',
        tradeId: '1',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: '1.00',
        requestId: 'polling-test',
        sourceApiKeyId: 'fixture-key',
      });
      const queued = await service.recordExecutionEvent({
        handoffId: handoff.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        observedAt: new Date().toISOString(),
        requestId: 'polling-test',
        sourceApiKeyId: 'fixture-key',
      });
      await db.owner.query(
        "UPDATE settlement_callback_deliveries SET request_body = jsonb_set(request_body, '{displayAmount}', '9999999999999.9901'::jsonb) WHERE delivery_id = $1",
        [queued.callbackDelivery.deliveryId],
      );
      const result = await new Promise<{
        status: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = fork(
          path.resolve(__dirname, 'helpers/settlementCallbackPollingProcess.ts'),
          [db.name],
          {
            execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
            cwd: path.resolve(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '../tsconfig.json') },
          },
        );
        let stdout = '',
          stderr = '',
          verificationSent = false;
        const deadline = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Scheduled callback fixture timed out'));
        }, 15_000);
        child.stdout!.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr!.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (
            !verificationSent &&
            (stderr.match(/Settlement callback polling failed/g) ?? []).length >= 2
          ) {
            verificationSent = true;
            child.send('verify-health');
          }
        });
        child.once('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once('close', (status, signal) => {
          clearTimeout(deadline);
          resolve({ status, signal, stdout, stderr });
        });
      });
      expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
      expect(result.stdout).toContain('POLL_PROCESS_SURVIVED');
      expect(
        (result.stderr.match(/Settlement callback polling failed/g) ?? []).length,
      ).toBeGreaterThanOrEqual(2);
      expect(result.stderr).not.toContain('9999999999999.9901');
      const persisted = await db.runtime.query(
        'SELECT status, attempt_count, lease_owner FROM settlement_callback_deliveries WHERE delivery_id=$1',
        [queued.callbackDelivery.deliveryId],
      );
      expect(persisted.rows).toEqual([{ status: 'pending', attempt_count: 0, lease_owner: null }]);
    } finally {
      await db.close();
    }
  });
});
