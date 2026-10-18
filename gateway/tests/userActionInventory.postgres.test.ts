import fs from 'fs';
import { keccak256 } from 'ethers';
/** SPDX-License-Identifier: Apache-2.0 */
import type { Server } from 'http';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import { createUserActionInventoryReader } from '../src/core/userActionEngine/inventory';
import { verifyUserAction, fingerprint } from '../src/core/userActionEngine/validation';
import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { createApp } from '../src/app';
import { createSettlementRouter } from '../src/routes/settlement';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { createServiceApiKeyLookup, createServiceAuthHeaders } from '../src/core/serviceAuth';
import { createSchemaValidator } from '../src/openapi/contract';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { config } from './helpers/settlementRoutesFixture';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
const operation = '33000000-0000-4000-8000-000000000001';
describeLocal('owned user-action inventory API with actual PostgreSQL projection', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>, server: Server | undefined;
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db = await createUserActionEnginePostgres();
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await db.close();
    jest.restoreAllMocks();
  });
  async function setup(executed = false) {
    const f = await userActionEngineFixture(
      db.runtime,
      'finalize_after_inspection_acceptance',
      'raw',
      'inventory',
      '2000000000',
      operation,
    );
    if (executed) await executeDormantUserAction(f.ports, f.input);
    else await f.requests.accept(f.input, await verifyUserAction(f.ports, f.input));
    const read = createUserActionInventoryReader(db.runtime);
    const runtimeConfig = {
      ...config,
      gaslessExecutionEnabled: false,
      settlementIngressEnabled: false,
    };
    const router = createSettlementRouter({
      config: runtimeConfig,
      settlementService: f.service,
      settlementStore: f.store,
      readUserActionInventory: read,
      nonceStore: createInMemoryNonceStore(),
      idempotencyStore: createInMemoryIdempotencyStore(),
      lookupServiceApiKey: createServiceApiKeyLookup(
        JSON.stringify([
          { id: 'owner', secret: 'owner-secret', active: true },
          { id: 'foreign', secret: 'foreign-secret', active: true },
        ]),
      ),
    });
    const app = createApp(runtimeConfig, {
      version: 'test',
      commitSha: 'test',
      buildTime: 'test',
      readinessCheck: async () => [],
      extraRouter: router,
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Address missing');
    const base = `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`;
    const get = (id = operation, owner = 'owner', query = '') => {
      const suffix = `/settlement/gasless-executions/user-action/operations/${id}`;
      return fetch(base + suffix + (query ? '?' + query : ''), {
        headers: {
          ...createServiceAuthHeaders({
            apiKey: owner,
            apiSecret: owner + '-secret',
            method: 'GET',
            path: '/api/dashboard-gateway/v1' + suffix,
            query,
          }),
        },
      });
    };
    return { ...f, read, base, get };
  }
  test('authenticated owner reads exact immutable instruction and hashes while issuance disabled; absent and foreign are identical404', async () => {
    const f = await setup(true);
    const response = await f.get();
    const payload = await response.json();
    expect(response.status).toBe(200);
    const inventory = payload.data;
    expect(inventory.request.handoffId).toBe(f.input.handoffId);
    expect(inventory.request.binding).toEqual(f.binding);
    expect(inventory.inventoryFingerprint).toBe(fingerprint(inventory.request));
    expect(inventory.request.outcomes[0].outcome_status).toBe('confirmed');
    expect(typeof inventory.request.outcomes[0].block_number).toBe('string');
    expect(typeof inventory.request.attempts[0].event_id).toBe('string');
    expect(
      createSchemaValidator(
        loadOpenApiSpec(),
        '#/components/schemas/SettlementUserActionInventory',
      )(inventory),
    ).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(f.input.userAuthorization.signature);
    expect(JSON.stringify(payload)).not.toContain('signedTransaction');
    if (process.env.USER_ACTION_INVENTORY_VECTOR_PATH) {
      const { userAuthorization, ...inputMetadata } = f.input;
      fs.writeFileSync(
        process.env.USER_ACTION_INVENTORY_VECTOR_PATH,
        JSON.stringify(
          {
            inventory,
            metadata: {
              controlledLocalFixture: true,
              resupplyMaterialExcluded: true,
              input: inputMetadata,
              authorization: {
                nonce: userAuthorization.nonce,
                deadline: userAuthorization.deadline,
                signatureFingerprint: keccak256(userAuthorization.signature),
              },
            },
          },
          null,
          2,
        ) + '\n',
      );
    }

    const foreign = await f.get(operation, 'foreign'),
      absent = await f.get('33000000-0000-4000-8000-000000000002');
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect((await foreign.json()).error.message).toBe((await absent.json()).error.message);
    expect(
      (await fetch(f.base + `/settlement/gasless-executions/user-action/operations/${operation}`))
        .status,
    ).toBe(401);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });
  test('malformed path/query cannot choose another owner; mutation route remains blocked', async () => {
    const f = await setup();
    expect((await f.get('bad')).status).toBe(400);
    expect((await f.get(operation, 'owner', 'owner=foreign')).status).toBe(400);
    const suffix = '/settlement/gasless-executions/user-action';
    const body = JSON.stringify(f.input);
    const response = await fetch(f.base + suffix, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'denied',
        ...createServiceAuthHeaders({
          apiKey: 'owner',
          apiSecret: 'owner-secret',
          method: 'POST',
          path: '/api/dashboard-gateway/v1' + suffix,
          body,
        }),
      },
      body,
    });
    expect(response.status).toBe(403);
    expect(f.sign).not.toHaveBeenCalled();
  });
  test('oversized attempt inventory fails closed without truncating accepted evidence', async () => {
    const f = await setup();
    const request = (await f.requests.inspect('owner', operation))!;
    await db.runtime.query(
      "INSERT INTO gasless_user_action_attempt_events(request_id,event_type) SELECT $1,'accepted' FROM generate_series(1,101)",
      [request.requestId],
    );
    expect((await f.get()).status).toBe(409);
    expect(
      (await db.runtime.query('SELECT * FROM gasless_user_action_attempt_events')).rowCount,
    ).toBe(102);
  });
  test('malformed persisted finality JSON is rejected rather than exposing signature/diagnostic fields', async () => {
    const f = await setup(true);
    await db.owner.query('UPDATE gasless_transaction_outcomes SET finality_evidence=$1', [
      { signature: f.input.userAuthorization.signature, providerDiagnostics: 'sensitive' },
    ]);
    const response = await f.get();
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(f.input.userAuthorization.signature);
    expect(text).not.toContain('sensitive');
    for (const method of [console.log, console.warn, console.error]) {
      expect(JSON.stringify(jest.mocked(method).mock.calls)).not.toContain(
        f.input.userAuthorization.signature,
      );
      expect(JSON.stringify(jest.mocked(method).mock.calls)).not.toContain('sensitive');
    }
  });
});
