/** SPDX-License-Identifier: Apache-2.0 */
import type { TransactionReceipt } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import * as finalityModule from '../src/core/gaslessChainFinality';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { createDormantUserActionRecoveryRuntime } from '../src/core/userActionEngine/recoveryRuntime';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
import { config } from './helpers/gaslessManagedSignerFixtures';
jest.mock('@agroasys/sdk/rpc/failoverProvider', () => ({ createManagedRpcProvider: jest.fn() }));
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal('explicit dormant observation scheduler (actual PostgreSQL/reconciler)', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  beforeEach(async () => {
    db = await createUserActionEnginePostgres();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await db.close();
  });
  async function setup() {
    const f = await userActionEngineFixture(db.runtime);
    f.ports.custody.outcomes.recordPrepared = async () => {
      throw new Error('lost durable outcome write');
    };
    await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('lost durable');
    const identity = (
      await db.runtime.query(
        "SELECT transaction_identity FROM gasless_user_action_attempt_events WHERE event_type='signed'",
      )
    ).rows[0].transaction_identity;
    const receipt = {
      hash: identity.transactionHash,
      to: f.input.contractAddress,
      status: 1,
      blockNumber: 101,
      blockHash: '0x' + 'a'.repeat(64),
      gasUsed: 90_000n,
      gasPrice: 2n,
    } as TransactionReceipt;
    const provider = {
      getTransactionReceipt: jest.fn<Promise<TransactionReceipt | null>, [string]>(
        async () => receipt,
      ),
      getTransaction: jest.fn(async () => null),
      getTransactionCount: jest.fn(async () => 7),
    };
    jest.mocked(createManagedRpcProvider).mockReturnValue(provider as never);
    jest.spyOn(finalityModule, 'createGaslessFinalityVerifier').mockReturnValue(f.finality);
    const c = {
      ...config,
      chainId: f.input.chainId,
      escrowAddress: f.input.contractAddress,
      usdcAddress: f.token,
      gaslessOutcomeReconciliationIntervalMs: 1000,
    };
    const runtime = createDormantUserActionRecoveryRuntime(c, db.runtime, f.store, f.service);
    return { ...f, identity, provider, runtime, c };
  }
  test('fresh observation-only runtime repairs known original identity and confirmed projection without signer/submission', async () => {
    const f = await setup();
    expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(0);
    await Promise.all([f.runtime.runOnce(), f.runtime.runOnce()]);
    expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe('confirmed');
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.provider).not.toHaveProperty('broadcastTransaction');
    const original = f.sign.mock.calls.length;
    await f.runtime.runOnce();
    expect(f.sign).toHaveBeenCalledTimes(original);
  });
  test('lifecycle-only reconciliation excludes enabled direct-send/funding outcomes and unknown signing without hash', async () => {
    const f = await setup();
    const recorder = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
    await recorder.recordPrepared({
      ...f.identity,
      transactionHash: '0x' + 'b'.repeat(64),
      applicationRequestId: 'old-funding-request',
      operation: 'create_trade',
    });
    await f.runtime.runOnce();
    expect(f.provider.getTransactionReceipt.mock.calls.map((call) => call[0])).toEqual([
      f.identity.transactionHash,
    ]);
    expect(
      (
        await db.runtime.query(
          "SELECT outcome_status FROM gasless_transaction_outcomes WHERE application_request_id='old-funding-request'",
        )
      ).rows[0].outcome_status,
    ).toBe('broadcast_pending');
  });
  test('start/stop register one observation tick; overlapping tick never starts another worker and limits are enforced', async () => {
    const f = await setup();
    let release!: () => void;
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.getTransactionReceipt.mockImplementation(async () => {
      entered();
      await barrier;
      return null;
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    f.runtime.start();
    f.runtime.start();
    await observed;
    jest.advanceTimersByTime(3000);
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    f.runtime.stop();
    release();
    await f.runtime.runOnce();
    jest.advanceTimersByTime(5000);
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    for (const limit of [0, 101, 1.5])
      await expect(f.runtime.runOnce(limit)).rejects.toThrow('Bounded');
    // Stop before fixture teardown; await in-flight observation through retained database projection.
    jest.useRealTimers();
    for (let i = 0; i < 100; i++) {
      const current = await f.requests.inspect('owner', f.input.sourceOperationId!);
      if (current?.outcomes[0]?.outcomeStatus === 'broadcast_unknown') break;
    }
  });
});
