/** SPDX-License-Identifier: Apache-2.0 */
import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { once } from 'events';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import type {
  RecoveryProcessInput,
  RecoveryProcessResult,
} from './helpers/userActionRecoveryProcess';
import type { GaslessUserAction } from '../src/core/gaslessExecutionTypes';
import { createServiceAuthHeaders } from '../src/core/serviceAuth';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal(
  'actual SIGKILL and fresh-process lifecycle recovery (controlled local ports)',
  () => {
    jest.setTimeout(120_000);
    let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
    const children = new Set<ChildProcess>();
    beforeEach(async () => {
      db = await createUserActionEnginePostgres();
    });
    afterEach(async () => {
      await Promise.all(
        [...children].map(async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
          }
        }),
      );
      children.clear();
      await db.close();
    });
    function start(message: Omit<RecoveryProcessInput, 'database'>) {
      const child = fork(path.resolve(__dirname, 'helpers/userActionRecoveryProcess.ts'), [], {
        execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        cwd: path.resolve(__dirname, '..'),
      });
      children.add(child);
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
      const exited = once(child, 'exit');
      const received = new Promise<RecoveryProcessResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', (result: RecoveryProcessResult) => resolve(result));
        child.once('exit', () =>
          reject(new Error('Child exited before its controlled IPC barrier')),
        );
      });
      child.send({ ...message, database: db.name });
      return { child, received, exited, output: () => output };
    }
    async function complete(message: Omit<RecoveryProcessInput, 'database'>) {
      const process = start(message);
      const result = await process.received;
      expect(result.type).toBe('complete');
      expect(await process.exited).toEqual([0, null]);
      expect(process.output()).not.toContain(message.input.userAuthorization.signature);
      expect(process.output()).not.toContain('77'.repeat(32));
      return result;
    }
    async function killAt(message: Omit<RecoveryProcessInput, 'database'>) {
      const process = start(message);
      const result = await process.received;
      expect(result).toMatchObject({ type: 'barrier', stage: message.boundary, broadcastCalls: 0 });
      expect(process.child.kill('SIGKILL')).toBe(true);
      expect(await process.exited).toEqual([null, 'SIGKILL']);
      expect(process.output()).not.toContain(message.input.userAuthorization.signature);
      return result;
    }
    async function fixture(
      mode: 'raw' | 'kms',
      action: GaslessUserAction = 'finalize_after_inspection_acceptance',
    ) {
      const f = await userActionEngineFixture(db.runtime, action, mode);
      return { ...f, message: { input: f.input, token: f.token, mode } };
    }
    async function retained() {
      return (
        await db.runtime.query(
          `SELECT execution_status AS status,request_id AS id FROM gasless_user_action_requests`,
        )
      ).rows[0];
    }
    test.each(['raw', 'kms'] as const)(
      '%s kill after committed signing fence never signs on restart or invents a missing hash',
      async (mode) => {
        const f = await fixture(mode);
        const stopped = await killAt({ ...f.message, operation: 'execute', boundary: 'signing' });
        expect(stopped.signerCalls).toBe(0);
        expect(await retained()).toEqual({ status: 'signing', id: stopped.requestId });
        const before = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
        expect(before.attempts.map((event) => event.eventType)).toEqual([
          'accepted',
          'claimed',
          'signing',
        ]);
        for (let i = 0; i < 2; i++) {
          expect(await complete({ ...f.message, operation: 'observe' })).toMatchObject({
            signerCalls: 0,
            broadcastCalls: 0,
            reads: 0,
          });
          expect(await complete({ ...f.message, operation: 'replay' })).toMatchObject({
            signerCalls: 0,
            broadcastCalls: 0,
            requestId: stopped.requestId,
          });
        }
        expect(
          await complete({
            ...f.message,
            operation: 'replay',
            input: { ...f.input, userAuthorization: { ...f.input.userAuthorization, nonce: '10' } },
          }),
        ).toMatchObject({ denied: true, signerCalls: 0, broadcastCalls: 0 });
        expect(await f.requests.inspect('owner', f.input.sourceOperationId!)).toEqual(before);
        expect(
          (await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount,
        ).toBe(0);
        expect(
          (await db.runtime.query('SELECT request_id FROM gasless_user_action_nonce_owners'))
            .rows[0].request_id,
        ).toBe(stopped.requestId);
      },
    );
    test.each([
      ['raw', 1, 'confirmed', 'finalize_after_inspection_acceptance'],
      ['kms', 1, 'confirmed', 'cancel_locked_timeout'],
      ['raw', 0, 'reverted', 'refund_in_transit_timeout'],
      ['kms', 0, 'reverted', 'finalize_after_inspection_acceptance'],
      ['raw', null, 'broadcast_unknown', 'cancel_locked_timeout'],
      ['kms', null, 'broadcast_unknown', 'refund_in_transit_timeout'],
    ] as const)(
      '%s killed after signed identity recovers only original %s receipt as %s (%s)',
      async (mode, receiptStatus, expected, action) => {
        const f = await fixture(mode, action);
        const stopped = await killAt({
          ...f.message,
          operation: 'execute',
          boundary: 'signed_identity',
        });
        expect(stopped.signerCalls).toBe(1);
        const signed = (
          await db.runtime.query(
            "SELECT transaction_identity AS identity, transaction_hash AS hash FROM gasless_user_action_attempt_events WHERE event_type='signed'",
          )
        ).rows[0];
        expect(signed.identity.applicationRequestId).toBe(stopped.requestId);
        expect(signed.identity.transactionHash).toBe(signed.hash);
        const nonceBefore = (await db.runtime.query('SELECT * FROM gasless_nonce_reservations'))
          .rows;
        expect(nonceBefore).toHaveLength(1);
        expect(nonceBefore[0]).toMatchObject({
          reservation_status: 'signed',
          signed_transaction_hash: signed.hash,
        });
        expect(JSON.stringify(signed.identity)).not.toContain(f.input.userAuthorization.signature);
        expect(
          (await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount,
        ).toBe(0);
        const before = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
        const restarted = await complete({ ...f.message, operation: 'observe', receiptStatus });
        expect(restarted).toMatchObject({
          signerCalls: 0,
          broadcastCalls: 0,
          reads: 1,
          requestId: stopped.requestId,
        });
        const after = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
        expect(after.attempts).toEqual(before.attempts);
        expect(after.outcomes).toEqual([
          { transactionHash: signed.hash, observedTransactionHash: null, outcomeStatus: expected },
        ]);
        expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe(expected);
        expect(await complete({ ...f.message, operation: 'replay' })).toMatchObject({
          signerCalls: 0,
          broadcastCalls: 0,
          requestId: stopped.requestId,
        });
        expect(
          (await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount,
        ).toBe(1);
        expect(await retained()).toEqual({ status: 'signing', id: stopped.requestId });
        expect((await db.runtime.query('SELECT * FROM gasless_nonce_reservations')).rows).toEqual(
          nonceBefore,
        );
        expect(
          (await db.runtime.query('SELECT request_id FROM gasless_user_action_nonce_owners'))
            .rows[0].request_id,
        ).toBe(stopped.requestId);
      },
    );
    test('pre-sign process death preserves stable request and historical claims; only exact resupply after lease expiry may sign', async () => {
      const f = await fixture('raw');
      const stopped = await killAt({ ...f.message, operation: 'execute', boundary: 'claimed' });
      expect(stopped.signerCalls).toBe(0);
      expect(await retained()).toEqual({ status: 'accepted', id: stopped.requestId });
      expect(await complete({ ...f.message, operation: 'execute' })).toMatchObject({
        denied: true,
        signerCalls: 0,
        broadcastCalls: 0,
      });
      // Deterministically advance this disposable DB lease, without a timing sleep or authority retirement.
      await db.runtime.query(
        "UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1",
        [stopped.requestId],
      );
      expect(
        await complete({
          ...f.message,
          operation: 'execute',
          input: { ...f.input, approvalScopeFingerprint: '0x' + '0'.repeat(64) },
        }),
      ).toMatchObject({ denied: true, signerCalls: 0, broadcastCalls: 0 });
      expect(
        await complete({
          ...f.message,
          operation: 'execute',
          input: { ...f.input, requestId: 'new-transport-request' },
        }),
      ).toMatchObject({ requestId: stopped.requestId, signerCalls: 1, broadcastCalls: 1 });
      const replay = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
      expect(replay.attempts.map((event) => event.eventType)).toEqual([
        'accepted',
        'claimed',
        'claimed',
        'signing',
        'signed',
      ]);
      expect(replay.outcomes).toHaveLength(1);
      expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe('confirmed');
    });
    test('actual authenticated HTTP pending idempotency lease survives SIGKILL; original same key/body executes once only after both leases expire', async () => {
      const f = await fixture('raw');
      const path = '/api/dashboard-gateway/v1/test-only/user-action';
      const key = 'controlled-http-process-key';
      const { requestId: _transport, sourceApiKeyId: _owner, ...body } = f.input;
      const post = (port: number, value: unknown = body) => {
        const raw = JSON.stringify(value);
        return fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            ...createServiceAuthHeaders({
              apiKey: 'owner',
              apiSecret: 'test-secret',
              method: 'POST',
              path,
              body: raw,
            }),
          },
          body: raw,
        });
      };
      const first = start({ ...f.message, operation: 'http', boundary: 'claimed' });
      const listening = await first.received;
      expect(listening.type).toBe('ready');
      const barrier = once(first.child, 'message');
      // Handle the expected disconnected HTTP socket immediately; it must not become an unhandled rejection.
      const lost = post(listening.port!).catch(() => null);
      const [committed] = (await barrier) as [RecoveryProcessResult];
      expect(committed).toMatchObject({
        type: 'barrier',
        stage: 'claimed',
        signerCalls: 0,
        broadcastCalls: 0,
      });
      const pending = (
        await db.runtime.query(
          `SELECT completed_at,EXTRACT(EPOCH FROM (lease_expires_at-created_at))*1000 AS duration FROM idempotency_keys WHERE idempotency_key=$1`,
          [key],
        )
      ).rows[0];
      expect(pending.completed_at).toBeNull();
      expect(Number(pending.duration)).toBe(300_000);
      expect(first.child.kill('SIGKILL')).toBe(true);
      expect(await first.exited).toEqual([null, 'SIGKILL']);
      expect(await lost).toBeNull();
      expect(await retained()).toEqual({ status: 'accepted', id: committed.requestId });

      const restarted = start({ ...f.message, operation: 'http' });
      const ready = await restarted.received;
      expect(ready.type).toBe('ready');
      const blocked = await post(ready.port!);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error.message).toContain('already in progress');
      expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(
        0,
      );
      // Simulate elapsed real lease time only in this disposable DB. Process death itself grants no permission.
      await db.runtime.query(
        "UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1",
        [committed.requestId],
      );
      const transportBlocked = await post(ready.port!);
      expect(transportBlocked.status).toBe(409);
      expect((await transportBlocked.json()).error.message).toContain('already in progress');
      expect(
        (await f.requests.inspect('owner', f.input.sourceOperationId!))?.attempts.map(
          (event) => event.eventType,
        ),
      ).toEqual(['accepted', 'claimed']);
      await db.runtime.query(
        "UPDATE idempotency_keys SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE idempotency_key=$1",
        [key],
      );
      const changed = await post(ready.port!, {
        ...body,
        approvalScopeFingerprint: '0x' + '0'.repeat(64),
      });
      expect(changed.status).toBe(409);
      await changed.json();
      const resumed = await post(ready.port!);
      expect(resumed.status).toBe(202);
      const result = await resumed.json();
      expect(result.data).toEqual({
        requestId: committed.requestId,
        signerCalls: 1,
        broadcastCalls: 1,
      });
      const replay = await post(ready.port!);
      expect(replay.status).toBe(202);
      expect(replay.headers.get('x-idempotent-replay')).toBe('true');
      expect(await replay.json()).toEqual(result);
      const finished = once(restarted.child, 'message');
      restarted.child.send({ command: 'stop' });
      expect((await finished)[0]).toMatchObject({
        type: 'complete',
        signerCalls: 1,
        broadcastCalls: 1,
        requestId: committed.requestId,
      });
      expect(await restarted.exited).toEqual([0, null]);
      expect((await db.runtime.query('SELECT * FROM gasless_user_action_requests')).rowCount).toBe(
        1,
      );
      expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(
        1,
      );
      expect(first.output() + restarted.output() + JSON.stringify(result)).not.toContain(
        body.userAuthorization.signature,
      );
    });
  },
);
