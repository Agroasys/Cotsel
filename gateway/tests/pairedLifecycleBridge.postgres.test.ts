/** SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import { Interface } from 'ethers';
import { createServer } from 'net';
import { createBoundUserActionFixture } from './helpers/boundUserActionFixture';
import { createPairedLifecycleTestClient } from './helpers/pairedLifecycleTestClient';
import { createUserActionExecutionScopeHash } from '../src/core/settlementUserActionBinding';
import { createGaslessPayloadHash } from '../src/core/gaslessRequestNormalization';
import type {
  GaslessUserAction,
  GaslessUserActionExecutionResult,
} from '../src/core/gaslessExecutionTypes';
import type { UserActionInventory } from '../src/core/userActionEngine/inventory';
import type { PairedAcceptedBody, PairedStart } from './helpers/pairedLifecycleProtocol';
import { USER_ACTION_RETIREMENT_PATH } from '../src/core/userActionEngine/retirementTransport';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
const execution = '/settlement/gasless-executions/user-action';
const abi = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
describeLocal(
  'opt-in paired HTTPS child bridge (real PG non-owner; controlled local ports)',
  () => {
    jest.setTimeout(120000);
    let client: ReturnType<typeof createPairedLifecycleTestClient>;
    beforeEach(() => {
      client = createPairedLifecycleTestClient();
    });
    afterEach(async () => {
      await client.close();
    });
    async function seed(
      action: GaslessUserAction = 'finalize_after_inspection_acceptance',
      mode: 'raw' | 'kms' = 'raw',
      barrier: PairedStart['barrier'] = null,
      contradictory = false,
    ) {
      const f = await createBoundUserActionFixture(
        action,
        String(Math.floor(Date.now() / 1000) + 600),
      );
      f.binding.packageId = f.input.actionPackageId = randomUUID();
      f.binding.sourceOperationId = f.input.sourceOperationId = randomUUID();
      f.binding.executionScopeHash = createUserActionExecutionScopeHash(f.input);
      const b = f.binding;
      const encode = (name: string, args: unknown[], address: string, index: number) => ({
        ...abi.encodeEventLog(abi.getEvent(name)!, args),
        address,
        index,
      });
      const witness = {
        chainId: b.chainId,
        receipt: {
          hash: b.fundingTransactionHash,
          to: b.escrowAddress,
          status: 1 as const,
          blockNumber: 100,
          blockHash: b.fundingBlockHash,
          logs: [
            encode(
              'TradeLocked',
              [
                b.tradeId,
                b.buyerAddress,
                b.supplierAddress,
                b.totalAmount,
                '100',
                '50',
                '450',
                b.supplierSecondTranche,
                '0x' + 'ab'.repeat(32),
              ],
              b.escrowAddress,
              0,
            ),
            encode('Transfer', [b.buyerAddress, b.escrowAddress, b.totalAmount], b.tokenAddress, 1),
          ],
        },
        blocks: [
          { number: 100, hash: b.fundingBlockHash },
          { number: 200, hash: '0x' + 'f'.repeat(64) },
        ],
        finalizedBlockNumber: 200,
      };
      const other = structuredClone(witness);
      if (contradictory) other.blocks[0].hash = '0x' + '9'.repeat(64);
      const ready = await client.start({
        custodyMode: mode,
        serviceAuth: { apiKeyId: 'owner', secret: 'test-only-paired-secret' },
        executionBinding: b,
        fundingWitnesses: [witness, other],
        barrier,
      });
      expect(ready.event).toBe('ready');
      expect(ready.ownerServiceId).toBe('owner');
      expect(ready.databaseName).toMatch(/^ua_[0-9a-f]{32}$/);
      expect(ready.runtimeRole).toBe(ready.databaseName);
      const registered = await client.http(
        ready.baseUrl!,
        '/settlement/handoffs',
        'POST',
        {
          platformId: 'agroasys',
          platformHandoffId: b.packageId,
          tradeId: b.tradeId,
          phase: b.phase,
          settlementChannel: 'cotsel_escrow',
          displayCurrency: 'USD',
          displayAmount: '1.00',
          assetSymbol: 'USDC',
          assetAmount: b.totalAmount,
          externalReference: b.sourceOperationId,
          executionBinding: b,
        },
        'register',
      );
      expect(registered.status).toBe(202);
      const handoff = (registered.body as { data: { handoffId: string } }).data;
      f.input.handoffId = handoff.handoffId;
      const { payloadHash: _hash, requestId: _id, sourceApiKeyId: _owner, ...payload } = f.input;
      f.input.payloadHash = createGaslessPayloadHash(payload);
      const { requestId: _request, sourceApiKeyId: _api, ...acceptedBody } = f.input;
      return { ...f, ready, acceptedBody: acceptedBody as PairedAcceptedBody };
    }
    async function pin(body: PairedAcceptedBody) {
      return client.command({ command: 'pinAcceptedBody', acceptedBody: body });
    }
    async function counters() {
      const response = await client.command({ command: 'inspectCounters' });
      expect(response.event).toBe('result');
      return response.counters!;
    }
    test('limits both paired and production routes before authentication or signing', async () => {
      const f = await seed();
      // The registration used one write request in the shared pre-authentication IP bucket.
      // Invalid credentials must still consume quota across both route sets.
      const invalidCaller = { apiKeyId: 'unknown', secret: 'invalid-test-only-secret' };
      const responses = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          client.http(
            index % 2 ? f.ready.baseUrl! : f.ready.productionBaseUrl!,
            execution,
            'POST',
            f.acceptedBody,
            `denied-${index}`,
            invalidCaller,
          ),
        ),
      );
      expect(responses.filter(({ status }) => status === 401)).toHaveLength(19);
      expect(responses.filter(({ status }) => status === 429)).toHaveLength(2);
      expect(await counters()).toMatchObject({
        acceptedRequests: 0,
        signerInvocations: 0,
        broadcastCalls: 0,
      });
    });
    test.each([
      ['raw', 'finalize_after_inspection_acceptance'],
      ['kms', 'finalize_after_inspection_acceptance'],
      ['raw', 'cancel_locked_timeout'],
      ['raw', 'refund_in_transit_timeout'],
    ] as const)(
      '%s %s authenticates handoff, signs once and returns matching inventory/result',
      async (mode, action) => {
        const f = await seed(action, mode);
        const pinned = await pin(f.acceptedBody);
        expect(pinned.event).toBe('result');
        const response = await client.http(
          f.ready.baseUrl!,
          execution,
          'POST',
          f.acceptedBody,
          'execute',
        );
        expect(response.status).toBe(202);
        const result = (response.body as { data: GaslessUserActionExecutionResult }).data;
        expect(result).toMatchObject({
          schemaVersion: 'cotsel.user-action-execution.v1',
          handoffId: f.input.handoffId,
          action,
          sourceOperationId: f.input.sourceOperationId,
          actionPackageId: f.input.actionPackageId,
          requestFingerprint: pinned.requestFingerprint,
          executionStatus: 'signing',
        });
        expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(result.outcomes).toHaveLength(1);
        const read = await client.http(
          f.ready.baseUrl!,
          `${execution}/operations/${f.input.sourceOperationId}`,
          'GET',
          undefined,
        );
        expect(read.status).toBe(200);
        const inventory = (read.body as { data: UserActionInventory }).data;
        expect(inventory.request).toMatchObject({
          requestId: result.requestId,
          binding: f.binding,
          requestFingerprint: result.requestFingerprint,
        });
        expect(
          inventory.request.attempts.filter((event) => event.event_type === 'signed')[0]
            .transaction_identity!.transactionHash,
        ).toBe(result.transactionHash);
        const replay = await client.http(
          f.ready.baseUrl!,
          execution,
          'POST',
          f.acceptedBody,
          'execute',
        );
        expect(replay.body).toEqual(response.body);
        const newKey = await client.http(
          f.ready.baseUrl!,
          execution,
          'POST',
          f.acceptedBody,
          'new-key',
        );
        expect((newKey.body as { data: GaslessUserActionExecutionResult }).data).toEqual(result);
        expect(await counters()).toMatchObject({
          acceptedRequests: 1,
          signerInvocations: 1,
          broadcastCalls: 1,
          outcomes: 1,
          transactionHashes: [result.transactionHash],
        });
        for (const value of [
          JSON.stringify(read.body),
          JSON.stringify(response.body),
          client.output(),
        ]) {
          expect(value).not.toContain(f.input.userAuthorization.signature);
          expect(value).not.toContain('77'.repeat(32));
        }
      },
    );
    test('funding disagreement in actual internal HTTP execution leaves no accepted authority or signer call', async () => {
      const f = await seed('finalize_after_inspection_acceptance', 'raw', null, true);
      expect((await pin(f.acceptedBody)).event).toBe('result');
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'execute')).status,
      ).toBe(503);
      expect(await counters()).toMatchObject({
        acceptedRequests: 0,
        signerInvocations: 0,
        broadcastCalls: 0,
        outcomes: 0,
      });
    });
    test('retirement read needs retained acceptance and connection failure cannot grant execution or mutate authority', async () => {
      const f = await seed();
      expect(await client.command({ command: 'releaseBarrier' })).toMatchObject({
        event: 'error',
        code: 'fixture_failed',
      });
      await pin(f.acceptedBody);
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Loopback port required');
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      const transport = {
        url: `https://127.0.0.1:${address.port}${USER_ACTION_RETIREMENT_PATH}`,
        owningServiceId: 'owner',
        apiKey: 'fixture-callback-key',
        apiSecret: 'fixture-callback-secret',
        timeoutMs: 1000,
      };
      expect(await client.command({ command: 'verifyRetirement', transport })).toMatchObject({
        event: 'result',
        retirement: { status: 'unavailable' },
      });
      expect(await counters()).toMatchObject({
        acceptedRequests: 0,
        signerInvocations: 0,
        broadcastCalls: 0,
      });
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'execute')).status,
      ).toBe(202);
      const before = await client.http(
        f.ready.baseUrl!,
        `${execution}/operations/${f.input.sourceOperationId}`,
        'GET',
        undefined,
      );
      expect(await client.command({ command: 'verifyRetirement', transport })).toMatchObject({
        event: 'result',
        retirement: { status: 'unavailable' },
      });
      expect(
        await client.command({
          command: 'verifyRetirement',
          transport: { ...transport, owningServiceId: 'foreign' },
        }),
      ).toMatchObject({ event: 'result', retirement: { status: 'unavailable' } });
      const after = await client.http(
        f.ready.baseUrl!,
        `${execution}/operations/${f.input.sourceOperationId}`,
        'GET',
        undefined,
      );
      expect((after.body as { data: UserActionInventory }).data).toEqual(
        (before.body as { data: UserActionInventory }).data,
      );
      expect(await counters()).toMatchObject({
        acceptedRequests: 1,
        signerInvocations: 1,
        broadcastCalls: 1,
        outcomes: 1,
      });
      const reply = await client.command({ command: 'verifyRetirement', transport });
      expect(reply.retirement).toEqual({ status: 'unavailable' });
      expect(await client.command({ command: 'releaseBarrier' })).toMatchObject({
        event: 'error',
        code: 'fixture_failed',
      });
      expect(JSON.stringify(reply)).not.toContain(transport.apiSecret);
      expect(JSON.stringify(reply)).not.toContain(f.input.userAuthorization.signature);
      expect(client.output()).not.toContain(transport.apiSecret);
    });
    test('public guard, foreign auth, unpinned request and changed accepted body fail without signing', async () => {
      const f = await seed();
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'unpinned')).status,
      ).toBe(503);
      expect((await pin(f.acceptedBody)).event).toBe('result');
      const publicResponse = await client.http(
        f.ready.productionBaseUrl!,
        execution,
        'POST',
        f.acceptedBody,
        'public',
      );
      expect(publicResponse.status).toBe(409);
      expect(JSON.stringify(publicResponse.body)).toContain('settlement_client_upgrade_required');
      expect(
        (
          await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'foreign', {
            apiKeyId: 'foreign',
            secret: 'test-only-paired-secret',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await client.http(
            f.ready.baseUrl!,
            execution,
            'POST',
            {
              ...f.acceptedBody,
              userAuthorization: { ...f.acceptedBody.userAuthorization, nonce: '10' },
            },
            'changed',
          )
        ).status,
      ).toBe(503);
      expect(await counters()).toMatchObject({
        acceptedRequests: 0,
        signerInvocations: 0,
        broadcastCalls: 0,
      });
    });
    test('lost response after signing marker is recovered by owned inventory without another signature', async () => {
      const f = await seed('finalize_after_inspection_acceptance', 'kms', 'signing');
      await pin(f.acceptedBody);
      const abort = new AbortController();
      const response = client
        .http(
          f.ready.baseUrl!,
          execution,
          'POST',
          f.acceptedBody,
          'execute',
          undefined,
          abort.signal,
        )
        .catch(() => null);
      const barrier = await client.wait((event) => event.event === 'barrierReached');
      expect(barrier).toMatchObject({
        stage: 'signing',
        counters: { signerInvocations: 0, broadcastCalls: 0, acceptedRequests: 1 },
      });
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'execute')).status,
      ).toBe(409);
      abort.abort();
      expect(await response).toBeNull();
      await client.command({ command: 'releaseBarrier' });
      const finished = await client.wait((event) => event.event === 'executionFinished');
      expect(finished).toMatchObject({
        executionResult: 'resolved',
        counters: { signerInvocations: 1, broadcastCalls: 1 },
      });
      const inventory = await client.http(
        f.ready.baseUrl!,
        `${execution}/operations/${f.input.sourceOperationId}`,
        'GET',
        undefined,
      );
      expect(inventory.status).toBe(200);
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'retry')).status,
      ).toBe(202);
      expect(await counters()).toMatchObject({
        acceptedRequests: 1,
        signerInvocations: 1,
        broadcastCalls: 1,
        outcomes: 1,
      });
    });
    test('deterministic pre-sign expiry fences old claimant and permits only exact resupply', async () => {
      const f = await seed('cancel_locked_timeout', 'raw', 'claimed');
      await pin(f.acceptedBody);
      const first = client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'execute');
      expect(await client.wait((event) => event.event === 'barrierReached')).toMatchObject({
        stage: 'claimed',
        counters: { signerInvocations: 0 },
      });
      expect(
        (await client.http(f.ready.baseUrl!, execution, 'POST', f.acceptedBody, 'execute')).status,
      ).toBe(409);
      expect(await client.command({ command: 'expirePreSignLeases' })).toMatchObject({
        event: 'result',
        requestLeaseRows: 1,
        httpLeaseRows: 1,
      });
      await client.command({ command: 'releaseBarrier' });
      expect((await first).status).toBe(503);
      expect(await counters()).toMatchObject({
        acceptedRequests: 1,
        signerInvocations: 0,
        broadcastCalls: 0,
      });
      const retry = await client.http(
        f.ready.baseUrl!,
        execution,
        'POST',
        f.acceptedBody,
        'execute',
      );
      expect(retry.status).toBe(202);
      expect(await counters()).toMatchObject({
        acceptedRequests: 1,
        signerInvocations: 1,
        broadcastCalls: 1,
        outcomes: 1,
      });
    });
  },
);
