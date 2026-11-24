/** SPDX-License-Identifier: Apache-2.0 */
// Review R05: a template version becomes active only through a durable
// preparation, an independent approval and a confirmation that is bound to the
// exact terms and the exact predecessor. Runs under the gateway runtime role.
import { randomUUID } from 'node:crypto';
import { AGROASYS_LAUNCH_TEMPLATE_V1, type SettlementTemplate } from '@agroasys/sdk';
import {
  DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST,
  createPostgresSettlementTemplateStore,
} from '../src/core/settlementTemplateStore';
import { createPostgresTemplateActivationStore } from '../src/core/settlementTemplateActivationStore';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

const version = (n: number): SettlementTemplate => ({
  ...AGROASYS_LAUNCH_TEMPLATE_V1,
  version: n,
  fees: { ...AGROASYS_LAUNCH_TEMPLATE_V1.fees, buyerBps: 40 + n },
});
const change = (actor: string) => ({ actor, requestId: `req-${actor}-${randomUUID()}` });

describePostgres('governed settlement template activation (review R05)', () => {
  jest.setTimeout(120_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  let templates: ReturnType<typeof createPostgresSettlementTemplateStore>;
  let activations: ReturnType<typeof createPostgresTemplateActivationStore>;
  const allow = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `agroasys.launch:${n}`);

  beforeAll(async () => {
    db = await createUserActionEnginePostgres();
    templates = createPostgresSettlementTemplateStore(db.runtime);
    activations = createPostgresTemplateActivationStore(db.runtime, {
      activationAllowlist: [...DEFAULT_TEMPLATE_ACTIVATION_ALLOWLIST, ...allow],
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  /** A reviewed draft authored by `author`. */
  async function reviewed(n: number, author = 'author') {
    await templates.createDraft({ template: version(n), actor: author, requestId: `d${n}` });
    return templates.review({ templateId: 'agroasys.launch', version: n, actor: 'reviewer' });
  }

  async function approvedPreparation(n: number) {
    const prepared = await activations.prepare({
      templateId: 'agroasys.launch',
      version: n,
      ...change('preparer'),
    });
    await activations.approve({ preparationId: prepared.preparationId, ...change('approver') });
    return prepared;
  }

  it('refuses activation without a recorded approval, even by direct UPDATE', async () => {
    await reviewed(2);
    const prepared = await activations.prepare({
      templateId: 'agroasys.launch',
      version: 2,
      ...change('preparer'),
    });
    await expect(
      activations.confirm({ preparationId: prepared.preparationId, ...change('approver') }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      db.runtime.query(
        `UPDATE settlement_templates SET status = 'active', activated_by = 'mallory', activated_at = NOW()
         WHERE template_id = 'agroasys.launch' AND version = 2`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Nor can a preparation be inserted already approved or confirmed.
    await expect(
      db.runtime.query(
        `INSERT INTO settlement_template_activations (preparation_id, template_id, version,
           template_hash, state, prepared_by, prepare_request_id, expires_at,
           approved_by, approved_at, approve_request_id)
         SELECT $1, template_id, version, template_hash, 'approved', 'x', 'r', NOW() + INTERVAL '1 hour',
           'y', NOW(), 'r'
         FROM settlement_templates WHERE template_id = 'agroasys.launch' AND version = 2`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses approval by the preparer or by the template author', async () => {
    await reviewed(3, 'author-3');
    const prepared = await activations.prepare({
      templateId: 'agroasys.launch',
      version: 3,
      ...change('preparer'),
    });
    for (const actor of ['preparer', 'author-3']) {
      await expect(
        activations.approve({ preparationId: prepared.preparationId, ...change(actor) }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({ reason: 'independent_approval_required' }),
      });
    }
  });

  it('activates exactly the approved terms and the expected predecessor', async () => {
    const prepared = await approvedPreparation(2);
    expect(prepared).toMatchObject({ expectedActiveVersion: 1 });
    const { activated, retired, preparation } = await activations.confirm({
      preparationId: prepared.preparationId,
      ...change('approver'),
    });
    expect(activated).toMatchObject({ version: 2, status: 'active', activatedBy: 'approver' });
    expect(retired).toMatchObject({ version: 1, status: 'retired' });
    expect(preparation).toMatchObject({ state: 'confirmed', approvedBy: 'approver' });

    // A retried confirmation transitions nothing again.
    await expect(
      activations.confirm({ preparationId: prepared.preparationId, ...change('approver') }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'activation_already_confirmed' }),
    });
    const active = await db.runtime.query(
      `SELECT version FROM settlement_templates WHERE template_id = 'agroasys.launch' AND status = 'active'`,
    );
    expect(active.rows).toEqual([{ version: 2 }]);
  });

  it('invalidates a confirmation once the predecessor it expected has changed', async () => {
    await reviewed(4);
    await reviewed(5);
    const first = await approvedPreparation(4);
    const second = await approvedPreparation(5);
    expect(first.expectedActiveVersion).toBe(2);
    expect(second.expectedActiveVersion).toBe(2);

    await activations.confirm({ preparationId: first.preparationId, ...change('approver') });
    await expect(
      activations.confirm({ preparationId: second.preparationId, ...change('approver') }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        reason: 'activation_preparation_stale',
        detail: 'active_version_changed',
      }),
    });
    // The supersession is committed, so the stale preparation can never be reused.
    expect(await activations.get(second.preparationId)).toMatchObject({
      state: 'superseded',
      supersededReason: 'active_version_changed',
    });
    expect((await templates.getActive('agroasys.launch'))?.version).toBe(4);
  });

  it('invalidates an approval whose target terms do not match', async () => {
    await reviewed(6);
    // A preparation that names other terms than the stored v6 (inserted directly).
    const forged = randomUUID();
    await db.runtime.query(
      `INSERT INTO settlement_template_activations (preparation_id, template_id, version,
         template_hash, expected_active_version, expected_active_hash, prepared_by,
         prepare_request_id, expires_at)
       SELECT $1, 'agroasys.launch', 6, '0x' || repeat('ab', 32), version, template_hash, 'preparer', 'r',
         NOW() + INTERVAL '1 hour'
       FROM settlement_templates WHERE template_id = 'agroasys.launch' AND status = 'active'`,
      [forged],
    );
    await expect(
      activations.approve({ preparationId: forged, ...change('approver') }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ detail: 'target_terms_changed' }),
    });
    expect(await activations.get(forged)).toMatchObject({ state: 'superseded' });
  });

  it('rechecks the current contract allowlist at confirmation', async () => {
    const prepared = await approvedPreparation(6);
    const stricter = createPostgresTemplateActivationStore(db.runtime);
    await expect(
      stricter.confirm({ preparationId: prepared.preparationId, ...change('approver') }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'template_not_enforced_by_contract' }),
    });
    expect((await templates.get('agroasys.launch', 6))?.status).toBe('reviewed');
  });

  it('lets exactly one of two concurrent confirmations win', async () => {
    await reviewed(7);
    await reviewed(8);
    const a = await approvedPreparation(7);
    const b = await approvedPreparation(8);
    const results = await Promise.allSettled([
      activations.confirm({ preparationId: a.preparationId, ...change('approver') }),
      activations.confirm({ preparationId: b.preparationId, ...change('approver') }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reason: 'activation_preparation_stale' }),
    });
    const active = await db.runtime.query(
      `SELECT count(*)::int AS n FROM settlement_templates
       WHERE template_id = 'agroasys.launch' AND status = 'active'`,
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('refuses an expired preparation', async () => {
    await reviewed(9);
    const shortLived = createPostgresTemplateActivationStore(db.runtime, {
      activationAllowlist: allow,
      ttlSeconds: 1,
    });
    const prepared = await shortLived.prepare({
      templateId: 'agroasys.launch',
      version: 9,
      ...change('preparer'),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(
      shortLived.approve({ preparationId: prepared.preparationId, ...change('approver') }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'activation_preparation_expired' }),
    });
  });

  it('keeps preparation evidence immutable', async () => {
    const [confirmed] = (await activations.list('agroasys.launch')).filter(
      (row) => row.state === 'confirmed',
    );
    for (const assignment of [
      `expected_active_version = 99`,
      `approved_at = approved_at - INTERVAL '1 day'`,
      `confirmed_by = 'someone-else'`,
      `state = 'prepared'`,
    ]) {
      await expect(
        db.runtime.query(
          `UPDATE settlement_template_activations SET ${assignment} WHERE preparation_id = $1`,
          [confirmed!.preparationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      db.runtime.query(`DELETE FROM settlement_template_activations WHERE preparation_id = $1`, [
        confirmed!.preparationId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot commit retirement without activating the confirmed replacement', async () => {
    const prepared = await approvedPreparation(9);
    const client = await db.runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE settlement_template_activations
        SET state = 'confirmed', confirmed_by = 'approver', confirmed_at = NOW(), confirm_request_id = 'bypass'
        WHERE preparation_id = $1`,
        [prepared.preparationId],
      );
      await client.query(`UPDATE settlement_templates
        SET status = 'retired', retired_by = 'approver', retired_at = NOW()
        WHERE template_id = 'agroasys.launch' AND status = 'active'`);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
