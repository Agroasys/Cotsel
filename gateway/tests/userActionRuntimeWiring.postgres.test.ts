/** SPDX-License-Identifier: Apache-2.0 */
import { Wallet, type TransactionReceipt } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import * as finalityModule from '../src/core/gaslessChainFinality';
import { createGaslessTransactionOutcomeRuntime } from '../src/core/gaslessTransactionOutcomeRuntime';
import { requireSignedTransactionIdentity } from '../src/core/gaslessTransactionLifecycle';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { config } from './helpers/gaslessManagedSignerFixtures';
import { Logger } from '../src/logging/logger';
jest.mock('@agroasys/sdk/rpc/failoverProvider', () => ({ createManagedRpcProvider: jest.fn() }));
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal(
  'production-owned single observer repairs lifecycle identities (actual PostgreSQL)',
  () => {
    jest.setTimeout(120_000);
    let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
    afterEach(async () => {
      jest.restoreAllMocks();
      await db?.close();
    });
    async function setup(throughVersion?: '202610170015') {
      db = await createUserActionEnginePostgres(throughVersion);
      const f = await userActionEngineFixture(db.runtime);
      const provider = {
        getTransactionReceipt: jest.fn(
          async (hash: string) =>
            ({
              hash,
              to: f.input.contractAddress,
              status: 1,
              blockNumber: 101,
              blockHash: '0x' + 'a'.repeat(64),
              gasUsed: 90_000n,
              gasPrice: 2n,
            }) as TransactionReceipt,
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
      };
      const make = () => createGaslessTransactionOutcomeRuntime(c, db.runtime, f.store, f.service);
      return { ...f, provider, make };
    }
    test.each(['raw', 'kms'] as const)(
      '%s known signed identity is repaired before existing observer selection without another signer/submission',
      async (mode) => {
        const f = await setup();
        if (mode === 'kms') f.ports.custody.signer = { mode: 'kms', transport: f.transport };
        f.ports.custody.outcomes.recordPrepared = async () => {
          throw new Error('lost durable write');
        };
        await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('lost durable');
        expect(
          (await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount,
        ).toBe(0);
        const identity = (
          await db.runtime.query(
            "SELECT transaction_identity FROM gasless_user_action_attempt_events WHERE event_type='signed'",
          )
        ).rows[0].transaction_identity;
        await expect(
          createPostgresGaslessTransactionOutcomeRecorder(db.runtime).recordPrepared({
            ...identity,
            sourceApiKeyId: 'foreign',
          }),
        ).rejects.toThrow();
        expect(
          (await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount,
        ).toBe(0);
        const spy = jest.spyOn(db.runtime, 'query');
        await f.make().runOnce(100);
        expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe('confirmed');
        expect(f.sign).toHaveBeenCalledTimes(1);
        expect(f.provider).not.toHaveProperty('broadcastTransaction');
        const repair = spy.mock.calls.find(
          ([sql]) => typeof sql === 'string' && sql.includes('SELECT e.transaction_identity'),
        );
        expect(repair?.[1]).toEqual([25]);
        const replay = await f.requests.inspect('owner', f.input.sourceOperationId!);
        expect(replay?.outcomes).toHaveLength(1);
        expect(replay?.outcomes[0].transactionHash).toBe(
          replay?.attempts.find((event) => event.eventType === 'signed')?.transactionHash,
        );
      },
    );
    test('migration015 without lifecycle request tables still observes existing funding outcomes and logs only a safe repair reason', async () => {
      const f = await setup('202610170015');
      expect(
        (await db.runtime.query("SELECT to_regclass('gasless_user_action_requests') AS name"))
          .rows[0].name,
      ).toBeNull();
      const wallet = new Wallet('0x' + '77'.repeat(32));
      const signed = await wallet.signTransaction({
        type: 2,
        chainId: f.input.chainId,
        nonce: 7,
        to: f.input.contractAddress,
        data: '0x',
        value: 0n,
        gasLimit: 100_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });
      const identity = requireSignedTransactionIdentity(signed, {
        applicationRequestId: 'historical-funding',
        resourceType: 'settlement_handoff',
        resourceId: f.input.handoffId,
        operation: 'create_trade',
        intentHash: '0x' + '1'.repeat(64),
        sourceApiKeyId: 'owner',
      });
      await createPostgresGaslessTransactionOutcomeRecorder(db.runtime).recordPrepared(identity);
      const log = jest.spyOn(Logger, 'error').mockImplementation(() => {});
      await f.make().runOnce();
      expect((await f.store.getHandoff(f.input.handoffId))?.executionStatus).toBe('confirmed');
      expect(log).toHaveBeenCalledWith('Lifecycle signed-identity repair requires recovery', {
        reason: 'user_action_identity_repair_unavailable',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(signed);
      expect(
        (await db.runtime.query('SELECT outcome_status FROM gasless_transaction_outcomes')).rows[0]
          .outcome_status,
      ).toBe('confirmed');
    });
    test('a signing marker with no retained hash remains unresolved; observer cannot invent signing authority', async () => {
      const f = await setup();
      f.ports.custody.signer = {
        mode: 'raw',
        wallet: {
          getAddress: async () => '0x' + '7'.repeat(40),
          signTransaction: async () => {
            throw new Error('unknown signer response');
          },
        },
      };
      await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('unknown signer');
      await f.make().runOnce();
      expect(f.provider.getTransactionReceipt).not.toHaveBeenCalled();
      expect((await db.runtime.query('SELECT * FROM gasless_transaction_outcomes')).rowCount).toBe(
        0,
      );
      expect((await f.requests.inspect('owner', f.input.sourceOperationId!))?.status).toBe(
        'signing',
      );
    });
  },
);
