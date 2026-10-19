/** SPDX-License-Identifier: Apache-2.0 */
// Explicit opt-in test process only. Never imported by server, SDK, or production routes.
import { readFileSync } from 'fs';
import { createServer, type Server } from 'https';
import { Router } from 'express';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../../src/app';
import { createSettlementRouter } from '../../src/routes/settlement';
import { createServiceAuthMiddleware, createServiceApiKeyLookup } from '../../src/core/serviceAuth';
import { createPostgresIdempotencyStore } from '../../src/core/idempotencyStore';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { SettlementService } from '../../src/core/settlementService';
import { GaslessSettlementExecutionService } from '../../src/core/gaslessSettlementExecutionService';
import { createPostgresGaslessRelayerBroadcastLock } from '../../src/core/gaslessRelayerBroadcastLock';
import { createOwnedUserActionAdapter } from '../../src/core/userActionEngine/adapter';
import { parseOwnedUserAction } from '../../src/core/userActionEngine/ingress';
import { fingerprint, requestIdentity } from '../../src/core/userActionEngine/validation';
import { createUserActionInventoryReader } from '../../src/core/userActionEngine/inventory';
import { createUserActionRequestStore } from '../../src/core/userActionEngine/requestStore';
import { assertUserActionPayloadHash } from '../../src/core/gaslessExecutionValidation';
import { assertUserActionMatchesBinding } from '../../src/core/settlementUserActionBinding';
import { GatewayError } from '../../src/errors';
import { successResponse } from '../../src/responses';
import { config } from './gaslessManagedSignerFixtures';
import { createUserActionEnginePostgres } from './userActionEnginePostgres';
import { pairedLifecyclePorts } from './pairedLifecyclePorts';
import { verifyPairedLifecycleRetirement } from './pairedLifecycleRetirement';
import type { GaslessUserActionExecutionInput } from '../../src/core/gaslessExecutionTypes';
import {
  PAIRED_PROTOCOL,
  parsePairedCommand,
  type PairedCommand,
  type PairedEvent,
  type PairedStart,
} from './pairedLifecycleProtocol';

const enabled = process.env.COTSEL_PAIRED_LIFECYCLE_FIXTURE === 'true' && Boolean(process.send);
if (!enabled) process.exit(2);
let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>> | undefined;
let server: Server | undefined;
let unblock: (() => void) | undefined;
const executions = new Set<Promise<void>>();
let commandQueue = Promise.resolve();
let runCommand: ((command: PairedCommand) => Promise<void>) | undefined;
let retirementReadInFlight = false;
let hasHeldBarrier = () => false;
const send = (event: Omit<PairedEvent, 'protocol'>) =>
  !process.connected
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) =>
        process.send!({ protocol: PAIRED_PROTOCOL, ...event }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
async function close() {
  unblock?.();
  await Promise.allSettled([...executions]);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await db?.close();
  db = undefined;
}
process.once('disconnect', () => {
  void close().finally(() => process.exit(0));
});
process.on('message', (value) => {
  let command: PairedCommand;
  try {
    command = parsePairedCommand(value);
  } catch {
    void send({ event: 'error', code: 'fixture_invalid' });
    return;
  }
  const executeCommand = async () => {
    try {
      if (command.command === 'start') {
        if (runCommand) throw new Error('Already started');
        runCommand = await start(command);
      } else {
        if (!runCommand) throw new Error('Not started');
        await runCommand(command);
      }
    } catch {
      await send({
        event: 'error',
        commandId: command.commandId,
        command: command.command,
        code: 'fixture_failed',
      });
      if (command.command === 'start') {
        await close();
        process.disconnect?.();
      }
    }
  };
  // Only release an already-held execution barrier while a read-only proof is waiting.
  // Every other command remains serialized; this never creates a new execution path.
  if (command.command === 'releaseBarrier' && retirementReadInFlight && hasHeldBarrier())
    void executeCommand();
  else commandQueue = commandQueue.then(executeCommand);
});
async function start(seed: PairedStart) {
  // Only the existing disposable local migration harness can select database/role credentials.
  db = await createUserActionEnginePostgres();
  const pool = db.runtime,
    binding = seed.executionBinding;
  const requests = createUserActionRequestStore(pool);
  let pinnedFingerprint: string | undefined,
    pinnedHandoff: string | undefined,
    activeKey: string | undefined;
  let pinnedInput: GaslessUserActionExecutionInput | undefined;
  let release: (() => void) | undefined,
    barrierUsed = false;
  hasHeldBarrier = () => Boolean(release);
  const counters = async () => {
    const [counts, hashes] = await Promise.all([
      pool.query(`SELECT (SELECT count(*)::int FROM gasless_user_action_requests) AS accepted,
        (SELECT count(*)::int FROM gasless_user_action_attempt_events) AS attempts,
        (SELECT count(*)::int FROM gasless_transaction_outcomes) AS outcomes`),
      pool.query(
        `SELECT DISTINCT transaction_hash AS hash FROM gasless_user_action_attempt_events WHERE transaction_hash IS NOT NULL ORDER BY hash LIMIT 100`,
      ),
    ]);
    return {
      acceptedRequests: counts.rows[0].accepted as number,
      executionAttempts: counts.rows[0].attempts as number,
      outcomes: counts.rows[0].outcomes as number,
      ...ports.counters(),
      transactionHashes: hashes.rows.map((row) => row.hash as string),
    };
  };
  const pause = async (stage: 'claimed' | 'signing') => {
    if (seed.barrier !== stage || barrierUsed) return;
    barrierUsed = true;
    const record = await requests.inspect(binding.ownerServiceId, binding.sourceOperationId);
    if (!record) throw new Error('Committed request required');
    const resumed = new Promise<void>((resolve, reject) => {
      release = resolve;
      unblock = () => reject(new Error('Controlled fixture closing'));
    });
    await send({
      event: 'barrierReached',
      stage,
      sourceOperationId: binding.sourceOperationId,
      requestId: record.requestId,
      counters: await counters(),
    });
    await resumed;
    unblock = undefined;
  };
  const ports = pairedLifecyclePorts(seed, pool, () => pause('signing'));
  const c = {
    ...config,
    chainId: Number(binding.chainId),
    escrowAddress: binding.escrowAddress,
    usdcAddress: binding.tokenAddress,
    settlementCallbackEnabled: false,
  };
  const store = createPostgresSettlementStore(pool),
    settlement = new SettlementService(c, store);
  const adapter = createOwnedUserActionAdapter({
    pool,
    store,
    settlementService: settlement,
    verifyFunding: ports.verifyFunding,
    verifyRetirement: async () => ({ status: 'unavailable' }),
    chainId: c.chainId,
    escrowAddress: c.escrowAddress,
    usdcAddress: c.usdcAddress,
    requestMaxTtlSeconds: 900,
  });
  adapter.bindCustody(ports.custody);
  const bindRuntime = adapter.bindRuntime;
  // Barrier wraps the owning service queue after acceptance/claim; it does not grant public authority.
  adapter.bindRuntime = (context) =>
    bindRuntime({
      ...context,
      enqueueBroadcast: (operation) =>
        context.enqueueBroadcast(async () => {
          await pause('claimed');
          return operation();
        }),
    });
  const unsupported = async (): Promise<never> => {
    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Fixture operation unsupported');
  };
  const service = new GaslessSettlementExecutionService(
    settlement,
    store,
    {
      simulateCreateTrade: unsupported,
      executeCreateTrade: unsupported,
      simulateWalletUsdcTransfer: unsupported,
      executeWalletUsdcTransfer: unsupported,
      simulateUserAction: adapter.simulate,
      executeUserAction: adapter.execute,
    },
    {
      chainId: c.chainId,
      escrowAddress: c.escrowAddress,
      usdcAddress: c.usdcAddress,
      requestMaxTtlSeconds: 900,
      userActionAdapter: adapter,
      verifyUserActionFunding: ports.verifyFunding,
      broadcastLock: createPostgresGaslessRelayerBroadcastLock(pool),
    },
  );
  const nonces = createInMemoryNonceStore();
  const lookup = createServiceApiKeyLookup(
    JSON.stringify([
      { id: seed.serviceAuth.apiKeyId, secret: seed.serviceAuth.secret, active: true },
    ]),
  );
  const auth = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 300,
    nonceTtlSeconds: 600,
    lookupApiKey: lookup,
    consumeNonce: nonces.consume.bind(nonces),
  });
  const idempotencyStore = createPostgresIdempotencyStore(pool);
  const root = Router(),
    paired = Router();
  paired.post(
    '/settlement/gasless-executions/user-action',
    auth,
    createIdempotencyMiddleware(idempotencyStore),
    (req, res, next) => {
      const execution = (async () => {
        const input = parseOwnedUserAction(
          req.body,
          req.requestContext!.requestId,
          req.serviceAuth!.apiKeyId,
        );
        if (
          !pinnedFingerprint ||
          requestIdentity(input).fingerprint !== pinnedFingerprint ||
          input.handoffId !== pinnedHandoff
        )
          throw new GatewayError(409, 'CONFLICT', 'Exact pinned fixture body required');
        activeKey = req.get('Idempotency-Key');
        return adapter.execute(input);
      })()
        .then(async (result) => {
          res.status(202).json(successResponse(result));
          await send({
            event: 'executionFinished',
            executionResult: 'resolved',
            sourceOperationId: binding.sourceOperationId,
            requestId: result.requestId,
            counters: await counters(),
          });
        })
        .catch(async () => {
          // No raw adapter/provider error object crosses HTTP or IPC.
          next(
            new GatewayError(
              503,
              'UPSTREAM_UNAVAILABLE',
              'Controlled user-action execution unavailable',
            ),
          );
          await send({
            event: 'executionFinished',
            executionResult: 'rejected',
            sourceOperationId: binding.sourceOperationId,
            counters: await counters(),
          });
        });
      executions.add(execution);
      void execution.finally(() => executions.delete(execution));
    },
  );
  const actualRoutes = () =>
    createSettlementRouter({
      config: c,
      settlementService: settlement,
      settlementStore: store,
      gaslessSettlementService: service,
      readUserActionInventory: createUserActionInventoryReader(pool),
      nonceStore: nonces,
      idempotencyStore,
      lookupServiceApiKey: lookup,
    });
  paired.use(actualRoutes());
  root.use('/paired', paired);
  root.use(actualRoutes());
  const app = createApp(c, {
    version: 'paired-fixture',
    commitSha: 'fixture',
    buildTime: 'fixture',
    readinessCheck: async () => [],
    extraRouter: root,
  });
  server = createServer(
    { key: readFileSync(seed.tls.keyPath), cert: readFileSync(seed.tls.certificatePath) },
    app,
  );
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener required');
  const productionBaseUrl = `https://127.0.0.1:${address.port}/api/dashboard-gateway/v1`;
  await send({
    event: 'ready',
    commandId: seed.commandId,
    command: 'start',
    baseUrl: productionBaseUrl + '/paired',
    productionBaseUrl,
    ownerServiceId: binding.ownerServiceId,
    databaseName: db.name,
    runtimeRole: db.name,
  });
  return async (command: PairedCommand) => {
    const result: Omit<PairedEvent, 'protocol'> = {
      event: 'result',
      command: command.command,
      commandId: command.commandId,
    };
    if (command.command === 'pinAcceptedBody') {
      const input = parseOwnedUserAction(
        command.acceptedBody,
        'paired-pin',
        binding.ownerServiceId,
      );
      const handoff = await store.getHandoff(input.handoffId);
      if (!handoff || fingerprint(handoff.executionBinding) !== fingerprint(binding))
        throw new Error('Seed binding mismatch');
      if (
        handoff.sourceApiKeyId !== binding.ownerServiceId ||
        handoff.externalReference !== binding.sourceOperationId ||
        handoff.tradeId !== binding.tradeId ||
        handoff.phase !== binding.phase ||
        handoff.settlementChannel !== 'cotsel_escrow'
      )
        throw new Error('Owned handoff required');
      assertUserActionMatchesBinding(binding, input, binding.tokenAddress);
      assertUserActionPayloadHash(input);
      const identity = requestIdentity(input).fingerprint;
      if (pinnedFingerprint && pinnedFingerprint !== identity)
        throw new Error('Pinned identity immutable');
      pinnedFingerprint = result.requestFingerprint = identity;
      pinnedHandoff = input.handoffId;
      pinnedInput = input;
    } else if (command.command === 'verifyRetirement') {
      retirementReadInFlight = true;
      try {
        result.retirement = pinnedInput
          ? await verifyPairedLifecycleRetirement(pool, pinnedInput, command.transport)
          : { status: 'unavailable' };
      } finally {
        retirementReadInFlight = false;
      }
    } else if (command.command === 'releaseBarrier') {
      if (!release) throw new Error('Barrier required');
      release();
      release = undefined;
    } else if (command.command === 'expirePreSignLeases') {
      if (!activeKey || !pinnedFingerprint) throw new Error('Pinned active HTTP request required');
      const client = await db!.owner.connect();
      try {
        await client.query('BEGIN');
        const request = await client.query(
          `UPDATE gasless_user_action_requests SET lease_expires_at=NOW()-INTERVAL '1 second'
          WHERE owner_service_id=$1 AND source_operation_id=$2 AND request_fingerprint=$3 AND execution_status='accepted' AND signing_started_at IS NULL AND lease_token IS NOT NULL`,
          [binding.ownerServiceId, binding.sourceOperationId, pinnedFingerprint],
        );
        const http = await client.query(
          `UPDATE idempotency_keys SET lease_expires_at=NOW()-INTERVAL '1 second'
          WHERE actor_id=$1 AND idempotency_key=$2 AND endpoint=$3 AND completed_at IS NULL`,
          [
            `service:${binding.ownerServiceId}`,
            activeKey,
            '/api/dashboard-gateway/v1/paired/settlement/gasless-executions/user-action',
          ],
        );
        await client.query('COMMIT');
        result.requestLeaseRows = request.rowCount!;
        result.httpLeaseRows = http.rowCount!;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else if (command.command === 'inspectCounters') result.counters = await counters();
    else if (command.command === 'shutdown') {
      await close();
      await send(result);
      process.disconnect?.();
      return;
    } else throw new Error('Unsupported fixture command');
    await send(result);
  };
}
