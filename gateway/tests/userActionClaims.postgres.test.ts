/** SPDX-License-Identifier: Apache-2.0 */
import { Pool } from 'pg';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { createUserActionRequestStore } from '../src/core/userActionEngine/requestStore';
import { verifyUserAction } from '../src/core/userActionEngine/validation';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { prepareUserActionCustody } from '../src/core/userActionEngine/custody';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal('user-action request PostgreSQL fencing', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  beforeEach(async () => {
    db = await createUserActionEnginePostgres();
  });
  afterEach(async () => {
    await db?.close();
  });
  async function awaitBlocked(blocker: number) {
    for (let i = 0; i < 100; i++) {
      const result = await db.owner.query(
        'SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
        [blocker],
      );
      if (result.rows[0].count > 0) return;
    }
    throw new Error('Expected separate-connection lock contention was not observed');
  }
  test('two replicas/new HTTP keys converge on one accepted operation and one signing claim', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const secondPool = new Pool({ ...db.runtime.options, max: 2 });
    const locker = await db.owner.connect();
    try {
      const second = createUserActionRequestStore(secondPool, 60, () => f.ports.now().getTime());
      const witness = await verifyUserAction(f.ports, f.input);
      await locker.query('BEGIN');
      await locker.query(
        'SELECT handoff_id FROM settlement_handoffs WHERE handoff_id=$1 FOR UPDATE',
        [f.input.handoffId],
      );
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const one = f.requests.accept(f.input, witness);
      const two = second.accept({ ...f.input, requestId: 'new-http-key' }, witness);
      await awaitBlocked(pid);
      await locker.query('COMMIT');
      const [a, b] = await Promise.all([one, two]);
      expect(a.requestId).toBe(b.requestId);
      const attempts = await Promise.allSettled([f.requests.claim(a), second.claim(b)]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        (
          await db.runtime.query(
            'SELECT event_type FROM gasless_user_action_attempt_events ORDER BY event_id',
          )
        ).rows,
      ).toEqual([{ event_type: 'accepted' }, { event_type: 'claimed' }]);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await secondPool.end();
    }
  });
  test('shared user authorization nonce cannot be accepted by a different owned package/operation', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const other = await userActionEngineFixture(db.runtime, 'cancel_locked_timeout', 'raw', 'two');
    const outcomes = await Promise.allSettled([
      verifyUserAction(f.ports, f.input).then((w) => f.requests.accept(f.input, w)),
      verifyUserAction(other.ports, other.input).then((w) => other.requests.accept(other.input, w)),
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect(
      (await db.runtime.query('SELECT request_id FROM gasless_user_action_requests')).rowCount,
    ).toBe(1);
  });
  test('expired pre-sign takeover fences old token before any raw signer call; signing never becomes reclaimable', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const witness = await verifyUserAction(f.ports, f.input),
      request = await f.requests.accept(f.input, witness);
    const stale = await f.requests.claim(request);
    await db.owner.query(
      "UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1",
      [request.requestId],
    );
    const recovered = await f.requests.claim(request);
    expect(recovered.token).not.toBe(stale.token);
    const fresh = await verifyUserAction(f.ports, f.input);
    const prepared = await prepareUserActionCustody(f.ports.custody, f.input, request.requestId);
    await expect(
      prepared.execute(
        () => f.requests.beginSigning(f.input, fresh, stale),
        (identity) => f.requests.recordSigned(stale, identity),
        (type, hash) => f.requests.recordHash(stale, type, hash),
      ),
    ).rejects.toThrow('fence');
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
    await f.requests.beginSigning(f.input, fresh, recovered);
    await expect(f.requests.claim(request)).rejects.toThrow('observation');
    await expect(
      f.requests.recordHash(stale, 'provider_hash', '0x' + 'a'.repeat(64)),
    ).rejects.toThrow('owner');
  });
  test('actual handoff lock contention changing status invalidates pre-sign witness', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const witness = await verifyUserAction(f.ports, f.input),
      request = await f.requests.accept(f.input, witness),
      claim = await f.requests.claim(request);
    const fresh = await verifyUserAction(f.ports, f.input);
    const locker = await db.owner.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        "UPDATE settlement_handoffs SET execution_status='failed' WHERE handoff_id=$1",
        [f.input.handoffId],
      );
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const attempt = f.requests.beginSigning(f.input, fresh, claim);
      const observed = attempt.catch((error) => error);
      await awaitBlocked(pid);
      await locker.query('COMMIT');
      expect(await observed).toMatchObject({ statusCode: 409 });
      expect((await f.requests.inspect('owner', f.input.sourceOperationId!))?.status).toBe(
        'accepted',
      );
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
  test('witness start expires during contention and slow funding cannot renew it', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const witness = await verifyUserAction(f.ports, f.input);
    const locker = await db.owner.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        'SELECT handoff_id FROM settlement_handoffs WHERE handoff_id=$1 FOR UPDATE',
        [f.input.handoffId],
      );
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const attempt = f.requests.accept(f.input, witness).catch((error) => error);
      await awaitBlocked(pid);
      f.advance(10_001);
      await locker.query('COMMIT');
      expect(await attempt).toMatchObject({ statusCode: 409 });
      f.funding.mockImplementation(async () => {
        f.advance(10_001);
      });
      await expect(verifyUserAction(f.ports, f.input)).rejects.toThrow('expired');
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
  test('funding is rechecked immediately before signing and RPC/signatures run outside DB transactions', async () => {
    const f = await userActionEngineFixture(db.runtime);
    const assertNoTransaction = async () => {
      const active = await db.owner.query(
        "SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state='idle in transaction'",
        [db.name],
      );
      expect(active.rows[0].count).toBe(0);
    };
    f.funding.mockImplementation(async () => {
      await assertNoTransaction();
      if (f.funding.mock.calls.length === 2) throw new Error('original funding canonicality lost');
    });
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('canonicality lost');
    expect(f.funding).toHaveBeenCalledTimes(2);
    expect(f.sign).not.toHaveBeenCalled();
  });
  test('runtime cannot alter/delete accepted identity or attempt history; event failure rolls back acceptance and signing', async () => {
    const f = await userActionEngineFixture(db.runtime),
      witness = await verifyUserAction(f.ports, f.input);
    await db.owner.query(
      "CREATE FUNCTION fail_user_action_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled audit failure'; END $$; CREATE TRIGGER controlled_audit_failure BEFORE INSERT ON gasless_user_action_attempt_events FOR EACH ROW EXECUTE FUNCTION fail_user_action_event()",
    );
    await expect(f.requests.accept(f.input, witness)).rejects.toThrow('audit failure');
    expect(
      (await db.runtime.query('SELECT request_id FROM gasless_user_action_requests')).rowCount,
    ).toBe(0);
    await db.owner.query(
      'DROP TRIGGER controlled_audit_failure ON gasless_user_action_attempt_events',
    );
    const request = await f.requests.accept(f.input, witness),
      claim = await f.requests.claim(request);
    await expect(
      db.runtime.query("UPDATE gasless_user_action_requests SET source_operation_id='changed'"),
    ).rejects.toThrow('immutable');
    await expect(db.runtime.query('DELETE FROM gasless_user_action_requests')).rejects.toThrow(
      'permission denied',
    );
    await expect(
      db.runtime.query("UPDATE gasless_user_action_attempt_events SET event_type='signed'"),
    ).rejects.toThrow('permission denied');
    await db.owner.query(
      'CREATE TRIGGER controlled_audit_failure BEFORE INSERT ON gasless_user_action_attempt_events FOR EACH ROW EXECUTE FUNCTION fail_user_action_event()',
    );
    await expect(
      f.requests.beginSigning(f.input, await verifyUserAction(f.ports, f.input), claim),
    ).rejects.toThrow('audit failure');
    expect((await f.requests.inspect('owner', f.input.sourceOperationId!))?.status).toBe(
      'accepted',
    );
    await db.owner.query(
      'DROP TRIGGER controlled_audit_failure ON gasless_user_action_attempt_events',
    );
    await f.requests.beginSigning(f.input, await verifyUserAction(f.ports, f.input), claim);
    await expect(
      db.owner.query(
        "UPDATE gasless_user_action_requests SET execution_status='accepted',signing_started_at=NULL",
      ),
    ).rejects.toThrow('irreversible');
    await expect(db.owner.query('DELETE FROM gasless_user_action_attempt_events')).rejects.toThrow(
      'immutable',
    );
  });
});
