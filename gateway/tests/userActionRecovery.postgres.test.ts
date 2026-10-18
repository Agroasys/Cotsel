/** SPDX-License-Identifier: Apache-2.0 */
import type { TransactionReceipt } from 'ethers';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { recoverUserActionSignedIdentities } from '../src/core/userActionEngine/recoverSignedIdentity';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
import { GaslessTransactionOutcomeReconciler } from '../src/core/gaslessTransactionOutcomeReconciler';
import { GaslessSettlementOutcomeObserver } from '../src/core/gaslessSettlementOutcomeObserver';
import { lockUserActionNonce } from '../src/core/userActionEngine/nonceLock';
import { nonceInventory } from '../src/core/userActionEngine/retirement';
import { verifyUserAction } from '../src/core/userActionEngine/validation';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal('known signed identity restart repair with existing observer', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  beforeEach(async () => {
    db = await createUserActionEnginePostgres();
  });
  afterEach(async () => {
    await db.close();
  });
  test.each(['raw', 'kms'] as const)(
    '%s retains exact signed identity when outcome persistence fails; fresh worker observes without submission',
    async (mode) => {
      const f = await userActionEngineFixture(
        db.runtime,
        'finalize_after_inspection_acceptance',
        mode,
      );
      f.ports.custody.outcomes.recordPrepared = async () => {
        throw new Error('controlled outcome transaction failed');
      };
      await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow(
        'outcome transaction failed',
      );
      expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
      expect(f.sign).toHaveBeenCalledTimes(1);
      const attempt = (
        await db.runtime.query(
          "SELECT transaction_identity FROM gasless_user_action_attempt_events WHERE event_type='signed'",
        )
      ).rows[0].transaction_identity;
      const outcomes = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
      // Multiple restarted workers converge through the existing outcome identity constraint.
      await Promise.all([
        recoverUserActionSignedIdentities(db.runtime, outcomes, 25),
        recoverUserActionSignedIdentities(db.runtime, outcomes, 25),
      ]);
      expect(
        (await db.runtime.query('SELECT transaction_hash FROM gasless_transaction_outcomes')).rows,
      ).toEqual([{ transaction_hash: attempt.transactionHash }]);
      const observer = new GaslessSettlementOutcomeObserver(f.store, f.service, f.ports.now);
      const receipt = {
        hash: attempt.transactionHash,
        to: f.input.contractAddress,
        status: 1,
        blockNumber: 101,
        blockHash: '0x' + 'a'.repeat(64),
        gasUsed: 90_000n,
        gasPrice: 2n,
      } as TransactionReceipt;
      const provider = {
        getTransactionReceipt: jest.fn(async () => receipt),
        getTransaction: jest.fn(async () => null),
        getTransactionCount: jest.fn(async () => 7),
      };
      await new GaslessTransactionOutcomeReconciler(
        outcomes,
        provider,
        observer,
        1000,
        f.finality,
      ).processUnresolved();
      expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe('confirmed');
      const replay = await executeDormantUserAction(f.ports, { ...f.input, requestId: 'restart' });
      expect(replay.outcomes[0].outcomeStatus).toBe('confirmed');
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
      const events = await f.service.listExecutionEvents(f.input.handoffId);
      expect(events.some((event) => event.eventType === 'confirmation_pending')).toBe(true);
      expect(events.some((event) => event.eventType === 'confirmed')).toBe(true);
      expect(JSON.stringify(events)).not.toContain(f.input.userAuthorization.signature);
    },
  );
  test('unknown signer response leaves no fabricated hash and cannot be recovered/re-signed automatically', async () => {
    const f = await userActionEngineFixture(db.runtime);
    f.sign.mockRejectedValueOnce(new Error('signer response unknown'));
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('unknown');
    const outcomes = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
    await recoverUserActionSignedIdentities(db.runtime, outcomes, 25);
    expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(0);
    await executeDormantUserAction(f.ports, { ...f.input, requestId: 'resupply' });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  test('managed response with competing calldata retains rejected hash and never submits or repairs it as intended', async () => {
    const f = await userActionEngineFixture(
      db.runtime,
      'finalize_after_inspection_acceptance',
      'kms',
    );
    const sign = f.sign.getMockImplementation()!;
    f.sign.mockImplementation((tx) => sign({ ...tx, data: '0x12345678' }));
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow(
      'outside the approved intent',
    );
    const replay = await f.requests.inspect('owner', f.input.sourceOperationId!);
    expect(replay?.attempts.filter((event) => event.eventType === 'signer_rejected')).toHaveLength(
      1,
    );
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
    await recoverUserActionSignedIdentities(
      db.runtime,
      createPostgresGaslessTransactionOutcomeRecorder(db.runtime),
      25,
    );
    expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(0);
  });
  test('non-owner grants and immutable identity guards reject altered signed identity, secrets, and competing signed events', async () => {
    const f = await userActionEngineFixture(db.runtime);
    await executeDormantUserAction(f.ports, f.input);
    const original = (
      await db.runtime.query(
        "SELECT * FROM gasless_user_action_attempt_events WHERE event_type='signed'",
      )
    ).rows[0];
    const replay = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
    for (const mutation of [
      { ...original.transaction_identity, signature: f.input.userAuthorization.signature },
      { ...original.transaction_identity, chainId: 1 },
      { ...original.transaction_identity, sourceApiKeyId: 'foreign' },
    ])
      await expect(
        db.runtime.query(
          "INSERT INTO gasless_user_action_attempt_events(request_id,event_type,lease_token,transaction_hash,transaction_identity) VALUES($1,'signed',$2,$3,$4)",
          [original.request_id, original.lease_token, original.transaction_hash, mutation],
        ),
      ).rejects.toThrow('identity_invalid');
    await expect(
      db.runtime.query(
        "INSERT INTO gasless_user_action_attempt_events(request_id,event_type,lease_token,transaction_hash,transaction_identity) VALUES($1,'signed',$2,$3,$4)",
        [
          original.request_id,
          original.lease_token,
          original.transaction_hash,
          original.transaction_identity,
        ],
      ),
    ).rejects.toThrow('duplicate key');
    expect(replay.outcomes).toHaveLength(1);
  });
  test('repair bounds are mandatory and altered concurrent outcome is not treated as exact replay', async () => {
    const f = await userActionEngineFixture(db.runtime);
    f.ports.custody.outcomes.recordPrepared = async () => {
      throw new Error('persistence failure');
    };
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('persistence failure');
    const recorder = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
    for (const limit of [0, 101, 1.5])
      await expect(recoverUserActionSignedIdentities(db.runtime, recorder, limit)).rejects.toThrow(
        'Bounded',
      );
    await expect(
      recoverUserActionSignedIdentities(
        db.runtime,
        {
          recordPrepared: async (identity) => {
            await recorder.recordPrepared({ ...identity, gasLimit: '200000' });
            throw new Error('concurrent mismatch');
          },
        },
        25,
      ),
    ).rejects.toThrow('original_signed_identity');
  });
  test('pre-sign audit failure rolls back marker and cannot invoke signer', async () => {
    const f = await userActionEngineFixture(db.runtime);
    await db.owner.query(
      "CREATE FUNCTION fail_signing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='signing' THEN RAISE EXCEPTION 'signing audit rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER controlled_signing_audit BEFORE INSERT ON gasless_user_action_attempt_events FOR EACH ROW EXECUTE FUNCTION fail_signing_audit()",
    );
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('audit rollback');
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
    expect((await f.requests.inspect('owner', f.input.sourceOperationId!))?.status).toBe(
      'accepted',
    );
    await db.owner.query(
      'DROP TRIGGER controlled_signing_audit ON gasless_user_action_attempt_events',
    );
    const witness = await verifyUserAction(f.ports, f.input);
    expect(witness).toBeDefined();
  });
  test('existing outcome writer waits for the same nonce lock while locked snapshot reads cannot deadlock', async () => {
    const f = await userActionEngineFixture(db.runtime);
    f.ports.custody.outcomes.recordPrepared = async () => {
      throw new Error('persistence failed');
    };
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('persistence failed');
    const outcomes = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
    await recoverUserActionSignedIdentities(db.runtime, outcomes, 25);
    const attempt = (await f.requests.inspect('owner', f.input.sourceOperationId!))!.attempts.find(
      (event) => event.eventType === 'signed',
    )!;
    const locker = await db.runtime.connect();
    try {
      await locker.query('BEGIN');
      await lockUserActionNonce(locker, {
        chainId: f.input.chainId,
        escrow: f.input.contractAddress.toLowerCase(),
        user: f.input.userAddress.toLowerCase(),
        nonce: f.input.userAuthorization.nonce,
      });
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const update = outcomes.markBroadcastUnknown(
        attempt.transactionHash!,
        'CONTROLLED_RESPONSE_UNKNOWN',
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await db.owner.query(
          'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (result.rows[0].count) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      const before = await nonceInventory(locker, f.input);
      expect(before.requests[0].outcomes[0].outcome_status).toBe('broadcast_pending');
      await locker.query('COMMIT');
      await update;
      expect(
        (await nonceInventory(db.runtime, f.input)).requests[0].outcomes[0].outcome_status,
      ).toBe('broadcast_unknown');
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});
