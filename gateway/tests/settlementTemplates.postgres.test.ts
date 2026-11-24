/** SPDX-License-Identifier: Apache-2.0 */
import { rmSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import {
  AGROASYS_LAUNCH_TEMPLATE_V1,
  settlementTemplateHash,
  type SettlementTemplate,
} from '@agroasys/sdk';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { createPostgresSettlementStore } from '../src/core/settlementStore';
import {
  DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST,
  createPostgresSettlementTemplateStore,
} from '../src/core/settlementTemplateStore';
import {
  createUserActionEnginePostgres,
  writeManifestThrough,
} from './helpers/userActionEnginePostgres';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

const V1_HASH = settlementTemplateHash(AGROASYS_LAUNCH_TEMPLATE_V1);
const V2: SettlementTemplate = {
  ...AGROASYS_LAUNCH_TEMPLATE_V1,
  version: 2,
  fees: { ...AGROASYS_LAUNCH_TEMPLATE_V1.fees, buyerBps: 40 },
};

function handoffInput(platformHandoffId: string) {
  return {
    platformId: 'template-tests',
    platformHandoffId,
    tradeId: '1',
    phase: 'lock',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: '1.00',
    assetSymbol: 'USDC',
    assetAmount: '1.000000',
    requestId: `req-${platformHandoffId}`,
    sourceApiKeyId: 'platform-main',
  };
}

describePostgres('settlement templates through PostgreSQL (Cotsel#940)', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;

  beforeAll(async () => {
    // Start at migration 016 with a settlement already recorded, then apply 017:
    // the backfill must attach v1 to settlements created before templates.
    db = await createUserActionEnginePostgres('202610180016');
    await db.owner.query(
      `INSERT INTO settlement_handoffs (
         handoff_id, platform_id, platform_handoff_id, trade_id, phase, settlement_channel,
         display_currency, display_amount, metadata, execution_status, reconciliation_status,
         callback_status, request_id, source_api_key_id)
       VALUES ('legacy-1', 'template-tests', 'legacy-1', '1', 'lock', 'cotsel_escrow', 'USD', 1,
         '{}', 'pending', 'pending', 'pending', 'req-legacy', 'platform-main')`,
    );
    await runVersionedMigrations({
      pool: db.owner,
      serviceName: 'gateway',
      manifestPath: path.resolve(__dirname, '../src/database/migrations.json'),
      runtimeDbUser: db.name,
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('seeds v1 active with exactly the SDK terms and backfills existing settlements', async () => {
    const store = createPostgresSettlementTemplateStore(db.runtime);
    const active = await store.getActive('agroasys.launch');
    expect(active).toMatchObject({
      templateId: 'agroasys.launch',
      version: 1,
      status: 'active',
      templateHash: V1_HASH,
      createdBy: 'migration:017',
    });
    expect(active?.template).toEqual(AGROASYS_LAUNCH_TEMPLATE_V1);

    const legacy = await createPostgresSettlementStore(db.runtime).getHandoff('legacy-1');
    expect(legacy?.settlementTemplate).toEqual({
      templateId: 'agroasys.launch',
      version: 1,
      templateHash: V1_HASH,
    });
  });

  it('records the active template on every new settlement', async () => {
    const store = createPostgresSettlementStore(db.runtime);
    const handoff = await store.createHandoff({
      ...handoffInput('after-templates'),
      tradeId: '2',
    });
    // The dashboard projection carries it too, for backfilled and new settlements.
    const projection = await store.getTradeSettlementProjectionMap(['1', '2']);
    for (const tradeId of ['1', '2']) {
      expect(projection.get(tradeId)?.settlementTemplate).toEqual({
        templateId: 'agroasys.launch',
        version: 1,
        templateHash: V1_HASH,
      });
    }
    expect(handoff.settlementTemplate).toEqual({
      templateId: 'agroasys.launch',
      version: 1,
      templateHash: V1_HASH,
    });
  });

  it('requires a second person to review and activate, and only allowlisted terms', async () => {
    const store = createPostgresSettlementTemplateStore(db.runtime);
    const draft = await store.createDraft({ template: V2, actor: 'alice', requestId: 'req-v2' });
    expect(draft).toMatchObject({ status: 'draft', templateHash: settlementTemplateHash(V2) });

    await expect(
      store.createDraft({ template: V2, actor: 'bob', requestId: 'x' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      store.review({ templateId: 'agroasys.launch', version: 2, actor: 'alice' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      store.activate({ templateId: 'agroasys.launch', version: 2, actor: 'bob' }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const reviewed = await store.review({
      templateId: 'agroasys.launch',
      version: 2,
      actor: 'bob',
    });
    expect(reviewed).toMatchObject({ status: 'reviewed', reviewedBy: 'bob' });

    await expect(
      store.activate({ templateId: 'agroasys.launch', version: 2, actor: 'alice' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      store.activate({ templateId: 'agroasys.launch', version: 2, actor: 'bob' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reason: 'template_not_enforced_by_contract' }),
    });
    expect((await store.getActive('agroasys.launch'))?.version).toBe(1);
  });

  it('activates a new version and retires the previous one in one transaction', async () => {
    const store = createPostgresSettlementTemplateStore(db.runtime, {
      activationAllowlist: [...DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST, 'agroasys.launch:2'],
    });
    const { activated, retired } = await store.activate({
      templateId: 'agroasys.launch',
      version: 2,
      actor: 'carol',
    });
    expect(activated).toMatchObject({ version: 2, status: 'active', activatedBy: 'carol' });
    expect(retired).toMatchObject({ version: 1, status: 'retired', retiredBy: 'carol' });
    const versions = await store.list('agroasys.launch');
    expect(versions.filter((row) => row.status === 'active').map((row) => row.version)).toEqual([
      2,
    ]);

    const handoff = await createPostgresSettlementStore(db.runtime).createHandoff(
      handoffInput('under-v2'),
    );
    expect(handoff.settlementTemplate?.version).toBe(2);
    const earlier = await createPostgresSettlementStore(db.runtime).getHandoff('legacy-1');
    expect(earlier?.settlementTemplate?.version).toBe(1);
  });

  it('keeps terms and history immutable in the database itself', async () => {
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET template = jsonb_set(template, '{fees,buyerBps}', '1')
         WHERE template_id = 'agroasys.launch' AND version = 2`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET status = 'active'
         WHERE template_id = 'agroasys.launch' AND version = 1`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.runtime.query(`DELETE FROM settlement_templates WHERE template_id = 'agroasys.launch'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.owner.query(`DELETE FROM settlement_templates WHERE template_id = 'agroasys.launch'`),
    ).rejects.toMatchObject({ code: '23514' });
    // The two-person rule holds even for a direct UPDATE that skips the store.
    const draft = await createPostgresSettlementTemplateStore(db.runtime).createDraft({
      template: { ...V2, version: 9 },
      actor: 'dave',
      requestId: 'req-v9',
    });
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET status = 'reviewed', reviewed_by = 'dave', reviewed_at = NOW()
         WHERE template_id = 'agroasys.launch' AND version = $1`,
        [draft.version],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET status = 'reviewed', reviewed_by = 'migration:017', reviewed_at = NOW()
         WHERE template_id = 'agroasys.launch' AND version = $1`,
        [draft.version],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const insertVersion = (version: number, status: string, createdBy: string, extra = '') =>
      db.runtime.query(
        `INSERT INTO settlement_templates (template_id, version, schema_version, template,
           template_hash, status, created_by, request_id${extra ? ', reviewed_by, reviewed_at, activated_by, activated_at' : ''})
         VALUES ('agroasys.launch', ${version}, 'cotsel.settlement-template.v1',
           jsonb_build_object('templateId', 'agroasys.launch', 'version', ${version},
             'schemaVersion', 'cotsel.settlement-template.v1'),
           '0x${String(version).repeat(64).slice(0, 64)}', '${status}', '${createdBy}', 'req'${extra})`,
      );
    // A version cannot be inserted already approved, nor claim the bootstrap actor.
    await expect(
      insertVersion(10, 'active', 'mallory', ", 'trent', NOW(), 'trent', NOW()"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insertVersion(11, 'draft', 'migration:017')).rejects.toMatchObject({
      code: '23514',
    });
  });

  // Review R06: approval evidence is the actor AND the time; both are frozen.
  it('freezes approval timestamps once recorded, under the runtime role', async () => {
    const rewrite = (column: string, version: number) =>
      db.runtime.query(
        `UPDATE settlement_templates SET ${column} = ${column} - INTERVAL '1 day'
         WHERE template_id = 'agroasys.launch' AND version = $1`,
        [version],
      );
    const active = await db.runtime.query<{ version: number }>(
      `SELECT version FROM settlement_templates
       WHERE template_id = 'agroasys.launch' AND status = 'active'`,
    );
    const activeVersion = active.rows[0]!.version;
    await expect(rewrite('reviewed_at', activeVersion)).rejects.toMatchObject({ code: '23514' });
    await expect(rewrite('activated_at', activeVersion)).rejects.toMatchObject({ code: '23514' });
    const retired = await db.runtime.query<{ version: number }>(
      `SELECT version FROM settlement_templates
       WHERE template_id = 'agroasys.launch' AND status = 'retired' LIMIT 1`,
    );
    expect(retired.rows).toHaveLength(1);
    await expect(rewrite('retired_at', retired.rows[0]!.version)).rejects.toMatchObject({
      code: '23514',
    });

    // A reviewed version's review time is frozen too, while its status stays reviewed.
    const store = createPostgresSettlementTemplateStore(db.runtime);
    const draft = await store.createDraft({
      template: { ...V2, version: 12 },
      actor: 'erin',
      requestId: 'req-v12',
    });
    await store.review({
      templateId: draft.templateId,
      version: draft.version,
      actor: 'frank',
    });
    await expect(rewrite('reviewed_at', draft.version)).rejects.toMatchObject({ code: '23514' });
    // A pair is filled only by its own transition: no activation stamp on a reviewed row.
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET retired_by = 'frank', retired_at = NOW()
         WHERE template_id = 'agroasys.launch' AND version = $1`,
        [draft.version],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never leaves the gateway without terms, and refuses settlements if it is', async () => {
    const store = createPostgresSettlementTemplateStore(db.runtime);
    await store.createDraft({
      template: { ...V2, version: 3 },
      actor: 'alice',
      requestId: 'req-v3',
    });
    await expect(
      store.retire({ templateId: 'agroasys.launch', version: 3, actor: 'alice' }),
    ).resolves.toMatchObject({ status: 'retired', retiredBy: 'alice' });
    await expect(
      store.retire({ templateId: 'agroasys.launch', version: 2, actor: 'erin' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reason: 'active_template_requires_replacement' }),
    });
    // Only a direct database change can leave no active version; the gateway
    // then refuses settlements rather than create one without terms.
    await db.owner.query(
      `UPDATE settlement_templates SET status = 'retired', retired_by = 'test', retired_at = NOW()
       WHERE template_id = 'agroasys.launch' AND status = 'active'`,
    );
    await expect(
      createPostgresSettlementStore(db.runtime).createHandoff(handoffInput('no-terms')),
    ).rejects.toMatchObject({
      statusCode: 503,
      details: expect.objectContaining({ reason: 'no_active_settlement_template' }),
    });
  });
});

describePostgres('settlement template backfill under forced row-level security', () => {
  jest.setTimeout(120_000);

  it('a non-superuser migrator still attaches v1 to every existing settlement', async () => {
    // The superuser test database bypasses RLS; production migrates as the
    // table owner, which FORCE ROW LEVEL SECURITY filters to zero rows unless
    // the migration sets the gateway service name itself.
    const base = await createUserActionEnginePostgres('202610180016');
    const { host, port } = base.owner.options;
    const role = `${base.name}_mig`;
    const database = `${base.name}_rls`;
    const connect = (options: string) => {
      const pool = new Pool({
        host,
        port,
        user: role,
        password: 'local-test-only',
        database,
        options,
      });
      // Cleanup drops the database WITH (FORCE); a backend still closing reports
      // 57P01 to its pool, which is expected and not a test failure.
      pool.on('error', () => undefined);
      return pool;
    };
    await base.owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'local-test-only' NOSUPERUSER`);
    await base.owner.query(`CREATE DATABASE ${database} OWNER ${role}`);
    const migrate = async (manifestPath: string) => {
      const owner = connect(`-c app.runtime_db_user=${base.name}`);
      try {
        await runVersionedMigrations({
          pool: owner,
          serviceName: 'gateway',
          manifestPath,
          runtimeDbUser: base.name,
        });
      } finally {
        await owner.end();
      }
    };
    const history = writeManifestThrough('202610180016');
    try {
      await migrate(history);
      const writer = connect('-c app.service_name=gateway');
      await writer.query(
        `INSERT INTO settlement_handoffs (
           handoff_id, platform_id, platform_handoff_id, trade_id, phase, settlement_channel,
           display_currency, display_amount, metadata, execution_status, reconciliation_status,
           callback_status, request_id)
         VALUES ('rls-1', 'p', 'rls-1', '1', 'lock', 'cotsel_escrow', 'USD', 1, '{}',
           'pending', 'pending', 'pending', 'r')`,
      );
      await migrate(path.resolve(__dirname, '../src/database/migrations.json'));
      const rows = await writer.query(
        'SELECT template_id, template_version FROM settlement_handoffs',
      );
      await writer.end();
      expect(rows.rows).toEqual([{ template_id: 'agroasys.launch', template_version: 1 }]);
    } finally {
      await base.owner.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await base.owner.query(`DROP ROLE IF EXISTS ${role}`);
      await base.close();
      rmSync(path.dirname(history), { recursive: true, force: true });
    }
  });
});
