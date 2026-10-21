/** SPDX-License-Identifier: Apache-2.0 */
import { Transaction, Interface, type TransactionResponse } from 'ethers';
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { verifyUserAction, DORMANT_ACTIONS } from '../src/core/userActionEngine/validation';
import { createUserActionRequestStore } from '../src/core/userActionEngine/requestStore';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal(
  'dormant user-action durable execution (controlled chain/signer, real PostgreSQL)',
  () => {
    jest.setTimeout(120_000);
    let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
    beforeAll(async () => {
      db = await createUserActionEnginePostgres();
    });
    afterAll(async () => {
      await db?.close();
    });
    // One independent database per scenario preserves all immutable rows and histories.
    async function run<T>(fn: (target: typeof db) => Promise<T>) {
      const target = await createUserActionEnginePostgres();
      try {
        return await fn(target);
      } finally {
        await target.close();
      }
    }
    test.each(['raw', 'kms'] as const)(
      '%s signs exact action calldata once across new-key and fresh-engine replay',
      async (mode) => {
        for (const action of DORMANT_ACTIONS)
          await run(async (target) => {
            const f = await userActionEngineFixture(target.runtime, action, mode);
            const result = await executeDormantUserAction(f.ports, f.input);
            expect(result.outcomes).toHaveLength(1);
            expect(result.outcomes[0].outcomeStatus).toBe('confirmed');
            const signed = Transaction.from(f.provider.broadcastTransaction.mock.calls[0][0]);
            const parsed = new Interface(AgroasysEscrow__factory.abi).parseTransaction({
              data: signed.data,
            });
            const functions = {
              finalize_after_inspection_acceptance:
                'finalizeAfterInspectionAcceptanceWithAuthorization',
              cancel_locked_timeout: 'cancelLockedTradeAfterTimeoutWithAuthorization',
              refund_in_transit_timeout: 'refundInTransitAfterTimeoutWithAuthorization',
            };
            expect(parsed?.name).toBe(functions[action]);
            expect(parsed?.args.map(String)).toEqual([
              '7',
              '9',
              f.input.userAuthorization.deadline,
              f.input.userAuthorization.signature,
            ]);
            expect(signed.to?.toLowerCase()).toBe(f.input.contractAddress);
            expect(signed.chainId).toBe(84532n);
            expect(signed.value).toBe(0n);
            f.advance(1_000_000);
            const replay = await executeDormantUserAction(
              { ...f.ports, requests: createUserActionRequestStore(target.runtime) },
              { ...f.input, requestId: 'new-key-request' },
            );
            expect(replay.requestId).toBe(result.requestId);
            expect(f.sign).toHaveBeenCalledTimes(1);
            expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
            await expect(
              executeDormantUserAction(f.ports, {
                ...f.input,
                userAuthorization: { ...f.input.userAuthorization, nonce: '10' },
              }),
            ).rejects.toThrow('replay conflicts');
            expect(
              await f.requests.inspect('another-owner', f.input.sourceOperationId!),
            ).toBeNull();
            const events = await target.runtime.query(
              'SELECT metadata FROM settlement_execution_events',
            );
            const stored = await target.runtime.query(
              'SELECT row_to_json(r) AS row FROM gasless_user_action_requests r',
            );
            for (const evidence of [result, replay, events.rows, stored.rows])
              expect(JSON.stringify(evidence)).not.toContain(f.input.userAuthorization.signature);
          });
      },
    );
    test.each([
      'broadcast_unknown',
      'confirmation_pending',
      'reverted',
      'provider_hash',
      'wait_replacement',
    ] as const)(
      '%s remains bound across restart without signing or broadcast again',
      async (fault) => {
        await run(async (target) => {
          const f = await userActionEngineFixture(target.runtime);
          const original = f.provider.broadcastTransaction.getMockImplementation()!;
          const other = '0x' + 'b'.repeat(64);
          if (fault === 'broadcast_unknown')
            f.provider.broadcastTransaction.mockImplementation(async () => {
              throw new Error('lost response');
            });
          if (fault === 'confirmation_pending')
            f.provider.broadcastTransaction.mockImplementation(
              async (bytes) =>
                ({
                  ...(await original(bytes)),
                  wait: async () => null,
                }) as unknown as TransactionResponse,
            );
          if (fault === 'reverted')
            f.provider.broadcastTransaction.mockImplementation(async (bytes) => {
              const response = await original(bytes);
              return {
                ...response,
                wait: async () => ({ ...(await response.wait()), status: 0 }),
              } as unknown as TransactionResponse;
            });
          if (fault === 'provider_hash')
            f.provider.broadcastTransaction.mockImplementation(
              async (bytes) =>
                ({ ...(await original(bytes)), hash: other }) as unknown as TransactionResponse,
            );
          if (fault === 'wait_replacement')
            f.provider.broadcastTransaction.mockImplementation(
              async (bytes) =>
                ({
                  ...(await original(bytes)),
                  wait: async () => {
                    throw {
                      code: 'TRANSACTION_REPLACED',
                      replacement: { hash: other },
                      receipt: { hash: '0x' + 'c'.repeat(64) },
                      privateProviderDiagnostic: 'PRIVATE_NOT_RETAINED',
                    };
                  },
                }) as unknown as TransactionResponse,
            );
          const result = await executeDormantUserAction(f.ports, f.input);
          if (fault === 'wait_replacement') {
            expect(result.attempts).toEqual(
              expect.arrayContaining([
                { eventType: 'provider_hash', transactionHash: other },
                { eventType: 'provider_hash', transactionHash: '0x' + 'c'.repeat(64) },
              ]),
            );
            expect(JSON.stringify(result)).not.toContain('PRIVATE_NOT_RETAINED');
          }
          expect(result.outcomes[0].outcomeStatus).toBe(
            fault === 'provider_hash'
              ? 'broadcast_unknown'
              : fault === 'wait_replacement'
                ? 'confirmation_pending'
                : fault,
          );
          const replay = await executeDormantUserAction(
            { ...f.ports, requests: createUserActionRequestStore(target.runtime) },
            { ...f.input, requestId: 'retry' },
          );
          expect(replay.requestId).toBe(result.requestId);
          expect(f.sign).toHaveBeenCalledTimes(1);
          expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
          if (fault === 'provider_hash')
            expect(result.attempts).toContainEqual({
              eventType: 'provider_hash',
              transactionHash: other,
            });
        });
      },
    );
    test.each(['open_dispute', 'finalize_after_dispute_window'] as const)(
      'unsupported %s cannot reach private engine authority',
      async (action) => {
        const f = await userActionEngineFixture(db.runtime, action, 'raw', action);
        await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow('unsupported');
        expect(f.sign).not.toHaveBeenCalled();
        expect(f.funding).not.toHaveBeenCalled();
      },
    );
    test('fresh pre-sign engine resumes only identical resupply, never a changed signature/deadline', async () => {
      await run(async (target) => {
        const f = await userActionEngineFixture(target.runtime);
        const witness = await verifyUserAction(f.ports, f.input);
        const request = await f.requests.accept(f.input, witness);
        const claim = await f.requests.claim(request);
        await target.owner.query(
          "UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1",
          [request.requestId],
        );
        await expect(
          executeDormantUserAction(f.ports, {
            ...f.input,
            userAuthorization: { ...f.input.userAuthorization, deadline: '2000000001' },
          }),
        ).rejects.toThrow();
        const result = await executeDormantUserAction(
          {
            ...f.ports,
            requests: createUserActionRequestStore(target.runtime, 60, () =>
              f.ports.now().getTime(),
            ),
          },
          { ...f.input, requestId: 'resupply' },
        );
        expect(result.requestId).toBe(request.requestId);
        expect(f.sign).toHaveBeenCalledTimes(1);
        await expect(f.requests.beginSigning(f.input, witness, claim)).rejects.toThrow();
      });
    });
    test.each(['signer_timeout', 'identity_persistence', 'projection'] as const)(
      '%s crash is quarantined after irreversible signing claim',
      async (fault) => {
        await run(async (target) => {
          const f = await userActionEngineFixture(target.runtime);
          if (fault === 'signer_timeout')
            f.sign.mockRejectedValueOnce(new Error('signer response lost'));
          if (fault === 'identity_persistence')
            f.ports.custody.outcomes.recordPrepared = async () => {
              throw new Error('identity persistence fault');
            };
          if (fault === 'projection') {
            const original = f.service.recordExecutionEvent.bind(f.service);
            f.ports.settlementService = {
              recordExecutionEvent: async (input) => {
                if (input.eventType === 'submitted') throw new Error('projection fault');
                return original(input);
              },
            };
          }
          await expect(executeDormantUserAction(f.ports, f.input)).rejects.toThrow();
          const replay = await executeDormantUserAction(
            { ...f.ports, requests: createUserActionRequestStore(target.runtime) },
            { ...f.input, requestId: 'restart' },
          );
          expect(replay.status).toBe('signing');
          expect(f.sign).toHaveBeenCalledTimes(1);
          expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(
            fault === 'projection' ? 1 : 0,
          );
        });
      },
    );
  },
);
