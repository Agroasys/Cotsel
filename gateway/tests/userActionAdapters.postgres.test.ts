import type { Server } from 'http';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../src/app';
import { createSettlementRouter } from '../src/routes/settlement';
import { createServiceAuthHeaders, createServiceApiKeyLookup } from '../src/core/serviceAuth';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import * as activation from '../src/core/gaslessExecutionValidation';
/** SPDX-License-Identifier: Apache-2.0 */
import { Wallet } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import * as finalityModule from '../src/core/gaslessChainFinality';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { createOwnedUserActionAdapter } from '../src/core/userActionEngine/adapter';
import { createManagedSignerGaslessSettlementExecutor } from '../src/core/gaslessManagedSignerExecutor';
import { createRawPrivateKeyGaslessSettlementExecutor } from '../src/core/gaslessRawPrivateKeyExecutor';
import { GaslessSettlementExecutionService } from '../src/core/gaslessSettlementExecutionService';
import { createPostgresGaslessRelayerBroadcastLock } from '../src/core/gaslessRelayerBroadcastLock';
import { DORMANT_ACTIONS } from '../src/core/userActionEngine/validation';
import { config } from './helpers/gaslessManagedSignerFixtures';
import type { GaslessUserAction } from '../src/core/gaslessExecutionTypes';
import { createSchemaValidator } from '../src/openapi/contract';
import { loadOpenApiSpec } from '../src/openapi/spec';
jest.mock('@agroasys/sdk/rpc/failoverProvider', () => ({ createManagedRpcProvider: jest.fn() }));
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
describeLocal('owning guarded execution adapters (real PG and local signatures)', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  beforeEach(async () => {
    db = await createUserActionEnginePostgres();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.close();
  });
  async function setup(
    mode: 'raw' | 'kms',
    action: GaslessUserAction = 'finalize_after_inspection_acceptance',
    retirement = true,
    capacity = false,
  ) {
    const f = await userActionEngineFixture(
      db.runtime,
      action,
      mode,
      'one',
      '2000000000',
      '44000000-0000-4000-8000-000000000001',
    );
    const adapter = createOwnedUserActionAdapter({
      pool: db.runtime,
      store: f.store,
      settlementService: f.service,
      verifyFunding: f.funding,
      verifyRetirement: retirement ? async () => ({ status: 'unavailable' }) : undefined,
      chainId: f.input.chainId,
      escrowAddress: f.input.contractAddress,
      usdcAddress: f.token,
      requestMaxTtlSeconds: 900,
    });
    const c = {
      ...config,
      chainId: f.input.chainId,
      escrowAddress: f.input.contractAddress,
      usdcAddress: f.token,
      gaslessSignerCustodyMode: mode === 'raw' ? ('raw_private_key' as const) : ('kms' as const),
      gaslessExecutorPrivateKey: '0x' + '77'.repeat(32),
      gaslessMaxGasLimit: 200_000n,
      gaslessMaxFeePerGasWei: 10n,
      gaslessMaxNativeCostWei: 1_000_000n,
      gaslessMinExecutorBalanceWei: 100n,
    };
    jest.mocked(createManagedRpcProvider).mockReturnValue(f.provider as never);
    jest.spyOn(finalityModule, 'createGaslessFinalityVerifier').mockReturnValue(f.finality);
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction');
    const executor =
      mode === 'kms'
        ? createManagedSignerGaslessSettlementExecutor(c, {
            userActionAdapter: adapter,
            loadUserActionHandoff: (id) => f.store.getHandoff(id),
            verifyUserActionFunding: f.funding,
            provider: f.provider,
            finalityVerifier: f.finality,
            signerTransport: f.transport,
            recordTransactionOutcome: f.ports.custody.outcomes,
            nonceReservationStore: f.ports.custody.nonces,
          })
        : createRawPrivateKeyGaslessSettlementExecutor(
            c,
            f.ports.custody.outcomes,
            (id) => f.store.getHandoff(id),
            f.funding,
            { adapter, nonces: f.ports.custody.nonces },
          );
    const service = new GaslessSettlementExecutionService(f.service, f.store, executor, {
      chainId: c.chainId,
      escrowAddress: c.escrowAddress,
      usdcAddress: c.usdcAddress,
      requestMaxTtlSeconds: 900,
      verifyUserActionFunding: f.funding,
      userActionAdapter: adapter,
      now: f.ports.now,
      broadcastLock: createPostgresGaslessRelayerBroadcastLock(db.runtime),
      capacityFailClosed: capacity,
      capacityRequiredExecutorBalanceWei: 2_000_000n,
      gasLimitCap: 200_000n,
      maxFeePerGasWei: 10n,
      minExecutorBalanceWei: 100n,
    });
    return { ...f, adapter, executor, service, sign, c };
  }
  test.each(['raw', 'kms'] as const)(
    '%s production-owned binding executes all three actions only through direct controlled internal adapter',
    async (mode) => {
      // Separate cases below cover actions independently without reusing their shared user nonce.
      const f = await setup(mode);
      await expect(f.service.executeUserAction(f.input)).rejects.toThrow(
        'settlement_client_upgrade_required',
      );
      await expect(f.executor.executeUserAction(f.input)).rejects.toThrow(
        'settlement_client_upgrade_required',
      );
      await expect(f.executor.simulateUserAction(f.input)).rejects.toThrow(
        'settlement_client_upgrade_required',
      );
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.provider.call).not.toHaveBeenCalled();
      const simulation = await f.adapter.simulate(f.input);
      expect(simulation.gasEstimate).toBe(100_000n);
      expect((await db.runtime.query('SELECT * FROM gasless_user_action_requests')).rowCount).toBe(
        0,
      );
      const result = await f.adapter.execute(f.input);
      expect(result.schemaVersion).toBe('cotsel.user-action-execution.v1');
      expect(result.transactionHash).toBe(result.outcomes[0].transactionHash);
      expect(result.requestId).not.toBe(f.input.requestId);
      expect(
        createSchemaValidator(
          loadOpenApiSpec(),
          '#/components/schemas/SettlementUserActionExecutionResult',
        )(result),
      ).toBe(true);
      f.advance(1_000_000);
      const replay = await f.adapter.execute({ ...f.input, requestId: 'new-http-request' });
      expect(replay).toEqual(result);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
      await expect(
        f.adapter.execute({
          ...f.input,
          userAuthorization: { ...f.input.userAuthorization, signature: '0x' + 'aa'.repeat(65) },
        }),
      ).rejects.toMatchObject({
        statusCode: 503,
        message: 'Bound user-action execution is unavailable',
      });
      expect(f.sign).toHaveBeenCalledTimes(1);
    },
  );
  test.each(
    DORMANT_ACTIONS.flatMap((action) =>
      (['raw', 'kms'] as const).map((mode) => ({ action, mode })),
    ),
  )(
    '$mode $action uses owning custody binding without widening eligibility',
    async ({ action, mode }) => {
      const f = await setup(mode, action);
      const result = await f.adapter.execute(f.input);
      expect(result.action).toBe(action);
      expect(result.outcomes[0].outcomeStatus).toBe('confirmed');
      expect(f.sign).toHaveBeenCalledTimes(1);
    },
  );
  test.each(['open_dispute', 'finalize_after_dispute_window'] as const)(
    '%s is rejected by internal adapter even without any public guard',
    async (action) => {
      const f = await setup('raw', action);
      await expect(f.adapter.execute(f.input)).rejects.toMatchObject({ statusCode: 503 });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.provider.call).not.toHaveBeenCalled();
      expect((await db.runtime.query('SELECT * FROM gasless_user_action_requests')).rowCount).toBe(
        0,
      );
    },
  );
  test('missing mandatory retirement transport and live capacity fence cannot create signing authority', async () => {
    const f = await setup('raw', 'finalize_after_inspection_acceptance', false);
    await expect(f.adapter.execute(f.input)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.funding).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
  });
  test('real service capacity guard refreshes observed balance and denies before signing', async () => {
    const f = await setup('kms', 'finalize_after_inspection_acceptance', true, true);
    await expect(f.adapter.execute(f.input)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.service.getRelayerReadiness().executorBalanceWei).toBe('1000000');
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  test('provider diagnostics cannot escape an internal adapter error or persisted event', async () => {
    const f = await setup('raw');
    f.provider.call.mockRejectedValueOnce(
      new Error('PRIVATE_PROVIDER_TOKEN ' + f.input.userAuthorization.signature),
    );
    await expect(f.adapter.execute(f.input)).rejects.toMatchObject({
      message: 'Bound user-action execution is unavailable',
      diagnostics: undefined,
    });
    expect(JSON.stringify(await f.store.listExecutionEvents(f.input.handoffId))).not.toContain(
      'PRIVATE_PROVIDER_TOKEN',
    );
    expect(f.sign).not.toHaveBeenCalled();
  });
  test.each(['raw', 'kms'] as const)(
    '%s guarded confirmed/failed/expired replay observes exact accepted body with funding unavailable',
    async (mode) => {
      const f = await setup(mode);
      const result = await f.adapter.execute(f.input);
      f.advance(1_000_000);
      f.funding.mockRejectedValue(new Error('PRIVATE_RPC_UNAVAILABLE'));
      const reads = f.funding.mock.calls.length;
      // Controlled test only. The production guard implementation still throws unconditionally.
      jest
        .spyOn(activation, 'requireReviewedUserActionCapability')
        .mockImplementation(() => undefined as never);
      expect(
        await f.service.executeUserAction({ ...f.input, requestId: 'confirmed-replay' }),
      ).toEqual(result);
      await db.owner.query(
        "UPDATE settlement_handoffs SET execution_status='failed' WHERE handoff_id=$1",
        [f.input.handoffId],
      );
      expect(
        await f.executor.executeUserAction({ ...f.input, requestId: 'failed-replay' }),
      ).toEqual(result);
      await expect(
        f.service.executeUserAction({ ...f.input, sourceApiKeyId: 'foreign' }),
      ).rejects.toThrow();
      await expect(
        f.service.executeUserAction({
          ...f.input,
          userAuthorization: { ...f.input.userAuthorization, deadline: '2000000001' },
        }),
      ).rejects.toThrow();
      expect(f.funding).toHaveBeenCalledTimes(reads);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    },
  );
  test('exact pre-sign resupply after expiry of failed unsigned lease resumes stable operation; a committed unknown signer never retries', async () => {
    const f = await setup('kms');
    f.provider.call.mockRejectedValueOnce(new Error('controlled pre-sign failure'));
    await expect(f.adapter.execute(f.input)).rejects.toThrow(
      'Bound user-action execution is unavailable',
    );
    const request = (await f.requests.inspect('owner', f.input.sourceOperationId!))!;
    expect(request.status).toBe('accepted');
    expect(f.sign).not.toHaveBeenCalled();
    await db.owner.query(
      "UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1",
      [request.requestId],
    );
    f.transport.signTransaction.mockRejectedValueOnce(new Error('PRIVATE_SIGN_RESPONSE_LOST'));
    await expect(f.adapter.execute({ ...f.input, requestId: 'resupplied' })).rejects.toThrow(
      'Bound user-action execution is unavailable',
    );
    const replay = await f.adapter.execute({ ...f.input, requestId: 'after-signer-loss' });
    expect(replay.requestId).toBe(request.requestId);
    expect(replay.transactionHash).toBeNull();
    expect(replay.executionStatus).toBe('signing');
    expect(f.transport.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  test('actual relayer queue wait revalidates original funding before signer invocation', async () => {
    const f = await setup('raw');
    const locker = await db.owner.connect();
    let attempt: Promise<unknown> | undefined;
    try {
      await locker.query("SELECT pg_advisory_lock(hashtext('gasless-relayer:broadcast'))");
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      attempt = f.adapter.execute(f.input).catch((error) => error);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const current = await db.owner.query(
          'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (current.rows[0].count) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      expect(f.sign).not.toHaveBeenCalled();
      f.funding.mockRejectedValue(new Error('canonical funding unavailable after queue wait'));
      await locker.query("SELECT pg_advisory_unlock(hashtext('gasless-relayer:broadcast'))");
      expect(await attempt).toMatchObject({ statusCode: 503 });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
    } finally {
      await locker.query("SELECT pg_advisory_unlock(hashtext('gasless-relayer:broadcast'))");
      locker.release();
      await attempt;
    }
  });
  test('HTTP/workflow owning adapters are wired after unconditional gates; test-only guard replacement still requires full owned signed body', async () => {
    const f = await setup('kms');
    let server: Server | undefined;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const router = createSettlementRouter({
        config: f.c,
        settlementService: f.ports.settlementService as never,
        settlementStore: f.store,
        gaslessSettlementService: f.service,
        nonceStore: createInMemoryNonceStore(),
        idempotencyStore: createInMemoryIdempotencyStore(),
        lookupServiceApiKey: createServiceApiKeyLookup(
          JSON.stringify([{ id: 'owner', secret: 'test-secret', active: true }]),
        ),
      });
      const app = createApp(f.c, {
        version: 'test',
        commitSha: 'fixture',
        buildTime: 'fixture',
        readinessCheck: async () => [],
        extraRouter: router,
      });
      server = await new Promise<Server>((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Address missing');
      const path = '/api/dashboard-gateway/v1/settlement/gasless-executions/user-action',
        url = `http://127.0.0.1:${address.port}${path}`;
      const { sourceApiKeyId: _owner, requestId: _request, ...body } = f.input;
      const post = (value: unknown, key: string) => {
        const raw = JSON.stringify(value);
        return fetch(url, {
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
      expect((await post(body, 'production-denial')).status).toBe(409);
      expect(f.sign).not.toHaveBeenCalled();
      jest
        .spyOn(activation, 'requireReviewedUserActionCapability')
        .mockImplementation(() => undefined as never);
      expect((await post({ ...body, sourceApiKeyId: 'foreign' }, 'forged-owner')).status).toBe(400);
      expect((await post({ ...body, actionPackageId: 'foreign' }, 'unbound')).status).toBe(409);
      expect(f.sign).not.toHaveBeenCalled();
      const response = await post(body, 'controlled-test-only');
      expect(response.status).toBe(202);
      const payload = await response.json();
      expect(
        createSchemaValidator(
          loadOpenApiSpec(),
          '#/components/schemas/SettlementGaslessUserActionExecutionResponse',
        )(payload),
      ).toBe(true);
      f.advance(1_000_000);
      f.funding.mockRejectedValue(new Error('PRIVATE_READ_OUTAGE'));
      const replay = await post(body, 'new-idempotency-key');
      expect(replay.status).toBe(202);
      expect((await replay.json()).data).toEqual(payload.data);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(payload)).not.toContain(body.userAuthorization.signature);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
