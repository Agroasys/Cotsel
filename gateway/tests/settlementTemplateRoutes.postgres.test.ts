/** SPDX-License-Identifier: Apache-2.0 */
// The settlement template routes (Cotsel#940) against the real store and
// PostgreSQL: guards, strict input, the two-person flow, the activation
// allowlist, idempotent replay, OpenAPI conformance and same-transaction audit.
import type { Server } from 'http';
import { Router } from 'express';
import { AGROASYS_LAUNCH_TEMPLATE_V1, type SettlementTemplate } from '@agroasys/sdk';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import {
  DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST,
  createPostgresSettlementTemplateStore,
} from '../src/core/settlementTemplateStore';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createPostgresTemplateActivationStore } from '../src/core/settlementTemplateActivationStore';
import { createSettlementTemplateRouter } from '../src/routes/settlementTemplates';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { freshStepUp } from './support/stepUp';
import { baseTestGatewayConfig } from './support/testConfig';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

// author and reviewer hold governance:write with a fresh step-up; stale has a
// one-hour-old step-up; reader is an operator without governance:write.
const SESSIONS: Record<string, { id: string; capabilities: string[]; stepUpAge: number }> = {
  'session-author': { id: 'author', capabilities: ['governance:write'], stepUpAge: 0 },
  'session-reviewer': { id: 'reviewer', capabilities: ['governance:write'], stepUpAge: 0 },
  'session-stale': { id: 'stale', capabilities: ['governance:write'], stepUpAge: 3600 },
  'session-reader': { id: 'reader', capabilities: [], stepUpAge: 0 },
};

function sessionClient(): AuthSessionClient {
  return {
    resolveSession: jest.fn().mockImplementation(async (token: string) => {
      const session = SESSIONS[token];
      if (!session) return null;
      return {
        accountId: `acct-${session.id}`,
        userId: `uid-${session.id}`,
        walletAddress: null,
        role: 'admin',
        email: `${session.id}@agroasys.io`,
        capabilities: session.capabilities,
        signerAuthorizations: [],
        authentication: freshStepUp(session.stepUpAge),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };
}

const V2: SettlementTemplate = {
  ...AGROASYS_LAUNCH_TEMPLATE_V1,
  version: 2,
  fees: { ...AGROASYS_LAUNCH_TEMPLATE_V1.fees, buyerBps: 40 },
};

describePostgres('settlement template routes (Cotsel#940)', () => {
  jest.setTimeout(120_000);
  const spec = loadOpenApiSpec();
  const validateVersion = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementTemplateVersionResponse',
  );
  const validateList = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementTemplateListResponse',
  );
  const validateActivation = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementTemplateActivationResponse',
  );
  const validateError = createSchemaValidator(spec, '#/components/schemas/ErrorResponse');
  const validatePreparation = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementTemplateActivationPreparationResponse',
  );
  const validatePreparationList = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementTemplateActivationPreparationListResponse',
  );

  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createUserActionEnginePostgres();
    const config: GatewayConfig = {
      ...baseTestGatewayConfig,
      enableMutations: true,
      writeAllowlist: ['uid-author', 'uid-reviewer', 'uid-stale', 'uid-reader'],
    };
    const router = Router();
    router.use(
      createSettlementTemplateRouter({
        authSessionClient: sessionClient(),
        config,
        templateStore: createPostgresSettlementTemplateStore(db.runtime),
        // v2 is allowed to activate; v4 below shows an unlisted version refused.
        activationStore: createPostgresTemplateActivationStore(db.runtime, {
          activationAllowlist: [...DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST, 'agroasys.launch:2'],
        }),
        idempotencyStore: createInMemoryIdempotencyStore(),
      }),
    );
    const app = createApp(config, {
      version: '0.1.0',
      commitSha: config.commitSha,
      buildTime: config.buildTime,
      readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
      extraRouter: router,
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await db?.close();
  });

  const call = (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    options: { body?: unknown; key?: string | null } = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.key === null || method === 'GET'
          ? {}
          : { 'Idempotency-Key': options.key ?? `key-${Math.random()}` }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  const auditRows = async () =>
    (
      await db.owner.query<{
        event_type: string;
        actor_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT event_type, actor_id, metadata FROM audit_log
         WHERE event_type LIKE 'gateway.settlement_template.%' ORDER BY id`,
      )
    ).rows;

  it('documents every route in OpenAPI', () => {
    expect(hasOperation(spec, 'GET', '/settlement-templates')).toBe(true);
    expect(hasOperation(spec, 'POST', '/settlement-templates')).toBe(true);
    expect(hasOperation(spec, 'GET', '/settlement-templates/activations')).toBe(true);
    for (const action of ['approve', 'confirm']) {
      expect(
        hasOperation(spec, 'POST', `/settlement-templates/activations/{preparationId}/${action}`),
      ).toBe(true);
    }
    // There is deliberately no direct activation operation.
    expect(
      hasOperation(spec, 'POST', '/settlement-templates/{templateId}/versions/{version}/activate'),
    ).toBe(false);
    for (const action of ['review', 'activations', 'retire']) {
      expect(
        hasOperation(
          spec,
          'POST',
          `/settlement-templates/{templateId}/versions/{version}/${action}`,
        ),
      ).toBe(true);
    }
    expect(hasOperation(spec, 'GET', '/settlement-templates/{templateId}/versions/{version}')).toBe(
      true,
    );
  });

  it('lists and reads the seeded active v1', async () => {
    const list = await call('GET', '/settlement-templates', 'session-reader');
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(validateList(listBody)).toBe(true);
    expect(listBody.data.items).toHaveLength(1);

    const one = await call(
      'GET',
      '/settlement-templates/agroasys.launch/versions/1',
      'session-reader',
    );
    const oneBody = await one.json();
    expect(validateVersion(oneBody)).toBe(true);
    expect(oneBody.data).toMatchObject({ status: 'active', template: AGROASYS_LAUNCH_TEMPLATE_V1 });

    expect(
      (await call('GET', '/settlement-templates/agroasys.launch/versions/7', 'session-reader'))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', '/settlement-templates/agroasys.launch/versions/0', 'session-reader'))
        .status,
    ).toBe(400);
  });

  it('guards every change: capability, fresh step-up and idempotency key', async () => {
    const reader = await call('POST', '/settlement-templates', 'session-reader', {
      body: { template: V2 },
    });
    expect(reader.status).toBe(403);

    const stale = await call('POST', '/settlement-templates', 'session-stale', {
      body: { template: V2 },
    });
    expect(stale.status).toBe(403);
    const staleBody = await stale.json();
    expect(validateError(staleBody)).toBe(true);
    expect(staleBody.error.details.reason).toBe('step_up_required');

    const noKey = await call('POST', '/settlement-templates', 'session-author', {
      body: { template: V2 },
      key: null,
    });
    expect(noKey.status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  it('accepts only exact template terms', async () => {
    const extra = await call('POST', '/settlement-templates', 'session-author', {
      body: { template: { ...V2, notes: 'unreviewed' } },
    });
    expect(extra.status).toBe(400);
    const badValues = await call('POST', '/settlement-templates', 'session-author', {
      body: {
        template: {
          ...V2,
          milestones: [{ id: 'only', releaseBps: 9000, deductsSupplierFee: true }],
        },
      },
    });
    expect(badValues.status).toBe(400);
    expect((await badValues.json()).error.details.problems).toContain(
      'milestone release shares must sum to exactly 10000 bps',
    );
  });

  it('runs draft -> review -> prepare -> approve -> confirm with two people, audited', async () => {
    const created = await call('POST', '/settlement-templates', 'session-author', {
      body: { template: V2 },
      key: 'draft-v2',
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(validateVersion(createdBody)).toBe(true);
    expect(createdBody.data).toMatchObject({ status: 'draft', createdBy: 'account:acct-author' });

    // The same key and body replays the response instead of a second draft.
    const replay = await call('POST', '/settlement-templates', 'session-author', {
      body: { template: V2 },
      key: 'draft-v2',
    });
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual(createdBody.data);

    const path = '/settlement-templates/agroasys.launch/versions/2';
    expect((await call('POST', `${path}/review`, 'session-author')).status).toBe(409);
    const reviewed = await call('POST', `${path}/review`, 'session-reviewer');
    expect(reviewed.status).toBe(200);
    expect(validateVersion(await reviewed.json())).toBe(true);

    // There is no direct activation route.
    expect((await call('POST', `${path}/activate`, 'session-reviewer')).status).toBe(404);

    const prepared = await call('POST', `${path}/activations`, 'session-author');
    expect(prepared.status).toBe(201);
    const preparedBody = await prepared.json();
    expect(validatePreparation(preparedBody)).toBe(true);
    expect(preparedBody.data).toMatchObject({
      state: 'prepared',
      expectedActiveVersion: 1,
      preparedBy: 'account:acct-author',
    });
    const prep = `/settlement-templates/activations/${preparedBody.data.preparationId}`;
    // Confirming before approval, and approving one's own preparation, are refused.
    expect((await call('POST', `${prep}/confirm`, 'session-reviewer')).status).toBe(409);
    expect((await call('POST', `${prep}/approve`, 'session-author')).status).toBe(409);
    const approved = await call('POST', `${prep}/approve`, 'session-reviewer');
    expect(approved.status).toBe(200);
    expect((await approved.json()).data).toMatchObject({
      state: 'approved',
      approvedBy: 'account:acct-reviewer',
    });
    // The template's author cannot be the one who activates it.
    const byAuthor = await call('POST', `${prep}/confirm`, 'session-author');
    expect(byAuthor.status).toBe(409);
    expect((await byAuthor.json()).error.details.reason).toBe('independent_activation_required');

    const activated = await call('POST', `${prep}/confirm`, 'session-reviewer');
    expect(activated.status).toBe(200);
    const activatedBody = await activated.json();
    expect(validateActivation(activatedBody)).toBe(true);
    expect(activatedBody.data.activated).toMatchObject({ version: 2, status: 'active' });
    expect(activatedBody.data.retired).toMatchObject({ version: 1, status: 'retired' });
    expect(activatedBody.data.preparation).toMatchObject({
      state: 'confirmed',
      approvedBy: 'account:acct-reviewer',
      expectedActiveVersion: 1,
    });
    // A second confirmation (new key) transitions nothing again.
    const again = await call('POST', `${prep}/confirm`, 'session-reviewer');
    expect(again.status).toBe(409);
    expect((await again.json()).error.details.reason).toBe('activation_already_confirmed');

    const list = await call('GET', '/settlement-templates/activations', 'session-reader');
    const listBody = await list.json();
    expect(validatePreparationList(listBody)).toBe(true);
    expect(listBody.data.items[0]).toMatchObject({ state: 'confirmed' });

    const retireActive = await call('POST', `${path}/retire`, 'session-reviewer');
    expect(retireActive.status).toBe(409);
    expect((await retireActive.json()).error.details.reason).toBe(
      'active_template_requires_replacement',
    );

    const rows = await auditRows();
    expect(rows.map((row) => row.event_type)).toEqual([
      'gateway.settlement_template.created',
      'gateway.settlement_template.reviewed',
      'gateway.settlement_template.activation_prepared',
      'gateway.settlement_template.activation_approved',
      'gateway.settlement_template.activated',
    ]);
    expect(rows.map((row) => row.actor_id)).toEqual([
      'account:acct-author',
      'account:acct-reviewer',
      'account:acct-author',
      'account:acct-reviewer',
      'account:acct-reviewer',
    ]);
    expect(rows[4].metadata).toMatchObject({
      version: 2,
      retiredVersion: 1,
      expectedActiveVersion: 1,
      preparedBy: 'account:acct-author',
      approvedBy: 'account:acct-reviewer',
    });
    for (const row of rows) {
      expect(row.metadata.stepUp).toMatchObject({ strength: 'hardware_webauthn' });
    }
  });

  it('refuses to activate terms the escrow does not enforce', async () => {
    await call('POST', '/settlement-templates', 'session-author', {
      body: { template: { ...V2, version: 4 } },
    });
    const path = '/settlement-templates/agroasys.launch/versions/4';
    expect((await call('POST', `${path}/review`, 'session-reviewer')).status).toBe(200);
    const refused = await call('POST', `${path}/activations`, 'session-author');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.details.reason).toBe('template_not_enforced_by_contract');
  });

  it('retires a draft and refuses a retired version afterwards', async () => {
    await call('POST', '/settlement-templates', 'session-author', {
      body: { template: { ...V2, version: 3 } },
    });
    const path = '/settlement-templates/agroasys.launch/versions/3';
    const retired = await call('POST', `${path}/retire`, 'session-author');
    expect(retired.status).toBe(200);
    expect((await retired.json()).data.status).toBe('retired');
    expect((await call('POST', `${path}/review`, 'session-reviewer')).status).toBe(409);
  });
});
