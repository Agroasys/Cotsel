/** SPDX-License-Identifier: Apache-2.0 */
import { createPostgresSettlementStore } from '../src/core/settlementStore';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { settlementAmountHttpFixture } from './helpers/settlementAmountHttpFixture';
import { SettlementService } from '../src/core/settlementService';
import { SettlementCallbackDispatcher } from '../src/core/settlementCallbackDispatcher';
import {
  DISPLAY_AMOUNT_SPEC,
  ASSET_AMOUNT_SPEC,
  parseSettlementAmount,
  readTopLevelJsonNumberLexemes,
} from '../src/core/settlementAmount';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

describePostgres('settlement amounts through PostgreSQL', () => {
  jest.setTimeout(60_000);
  let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
  let http: Awaited<ReturnType<typeof settlementAmountHttpFixture>>;
  beforeAll(async () => {
    db = await createUserActionEnginePostgres();
    http = await settlementAmountHttpFixture(db.runtime);
  });
  afterAll(async () => {
    try {
      await http?.close();
    } finally {
      await db?.close();
    }
  });

  test.each([
    ['display_amount', '9007199254740993.01'],
    ['asset_amount', '9007199254740993.000001'],
    ['display_amount', '-0.01'],
  ])(
    'rejects an unsupported stored %s instead of returning rounded money',
    async (column, value) => {
      const store = createPostgresSettlementStore(db.runtime);
      const handoff = await store.createHandoff({
        platformId: 'amount-tests',
        platformHandoffId: `stored-${column}-${value}`,
        tradeId: '1',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: '1.00',
        assetSymbol: 'USDC',
        assetAmount: '1.000000',
        requestId: 'stored-amount-test',
        sourceApiKeyId: 'platform-main',
      });
      // Simulate a legacy/backfilled row outside the application's approved magnitude.
      // The enum above is a closed test fixture, never request input.
      await db.owner.query(`UPDATE settlement_handoffs SET ${column} = $1 WHERE handoff_id = $2`, [
        value,
        handoff.handoffId,
      ]);
      await expect(store.getHandoff(handoff.handoffId)).rejects.toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
      await expect(
        new SettlementService(http.config, store).recordExecutionEvent({
          handoffId: handoff.handoffId,
          eventType: 'submitted',
          executionStatus: 'submitted',
          reconciliationStatus: 'pending',
          observedAt: new Date().toISOString(),
          requestId: `invalid-${handoff.handoffId}`,
          sourceApiKeyId: 'platform-main',
        }),
      ).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
      for (const table of ['settlement_execution_events', 'settlement_callback_deliveries']) {
        const result = await db.owner.query(
          `SELECT count(*)::text AS count FROM ${table} WHERE handoff_id = $1`,
          [handoff.handoffId],
        );
        expect(result.rows[0].count).toBe('0');
      }
    },
  );

  function body(id: string, amounts: string): string {
    return `{"platformId":"amount-tests","platformHandoffId":"${id}","tradeId":"1","phase":"lock","settlementChannel":"cotsel_escrow","displayCurrency":"USD","assetSymbol":"USDC",${amounts}}`;
  }

  test.each([
    ['maximum', '9999999999999.99', '999999999.999999', true],
    ['fraction', '0.01', '0.000001', true],
    ['zero', '0.00', '0.000000', true],
    ['legacy-number', '623.06', '12.345678', false],
  ])(
    'preserves %s through signed HTTP, PostgreSQL, replay and authenticated callback',
    async (id, display, asset, strings) => {
      const amounts = `"displayAmount":${strings ? JSON.stringify(display) : display},"assetAmount":${strings ? JSON.stringify(asset) : asset}`;
      const rawBody = body(id, amounts);
      const response = await http.post(rawBody, id);
      expect(response.status).toBe(202);
      const payload = (await response.json()) as {
        data: { handoffId: string; displayAmount: number; assetAmount: number };
      };
      expect(
        parseSettlementAmount(payload.data.displayAmount, 'displayAmount', DISPLAY_AMOUNT_SPEC),
      ).toBe(display);
      expect(
        parseSettlementAmount(payload.data.assetAmount, 'assetAmount', ASSET_AMOUNT_SPEC),
      ).toBe(asset);
      const row = await db.runtime.query(
        'SELECT display_amount::text, asset_amount::text, source_api_key_id FROM settlement_handoffs WHERE handoff_id = $1',
        [payload.data.handoffId],
      );
      expect(row.rows).toEqual([
        { display_amount: display, asset_amount: asset, source_api_key_id: 'platform-main' },
      ]);
      for (const key of [id, `${id}-fresh-transport`]) {
        const replay = await http.post(rawBody, key);
        expect(replay.status).toBe(202);
        expect(((await replay.json()) as typeof payload).data.handoffId).toBe(
          payload.data.handoffId,
        );
      }
      const otherOwner = await http.post(rawBody, `${id}-other-owner`, 'platform-other');
      expect(otherOwner.status).toBe(403);
      const changedBody = body(id, '"displayAmount":"2.00","assetAmount":"2.000000"');
      for (const key of [id, `${id}-changed-intent`]) {
        const changed = await http.post(changedBody, key);
        expect(changed.status).toBe(409);
      }
      const restartedStore = createPostgresSettlementStore(db.runtime);
      const persisted = await restartedStore.getHandoff(payload.data.handoffId);
      expect(persisted?.displayAmount).toBe(payload.data.displayAmount);
      await new SettlementService(http.config, restartedStore).recordExecutionEvent({
        handoffId: payload.data.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        observedAt: new Date().toISOString(),
        requestId: `callback-${id}`,
        sourceApiKeyId: 'platform-main',
      });
      const before = http.receipts.length;
      const dispatcher = new SettlementCallbackDispatcher(
        http.config,
        createPostgresSettlementStore(db.runtime),
      );
      await dispatcher.processDueDeliveries();
      expect(http.receipts).toHaveLength(before + 1);
      const receipt = http.receipts[before]!;
      expect(receipt.body.handoffId).toBe(payload.data.handoffId);
      const callbackLexeme = readTopLevelJsonNumberLexemes(Buffer.from(receipt.rawBody))?.get(
        'displayAmount',
      );
      expect(parseSettlementAmount(callbackLexeme, 'displayAmount', DISPLAY_AMOUNT_SPEC)).toBe(
        display,
      );
      const deliveries = await db.runtime.query(
        'SELECT status, attempt_count FROM settlement_callback_deliveries WHERE handoff_id = $1',
        [payload.data.handoffId],
      );
      expect(deliveries.rows).toEqual([{ status: 'delivered', attempt_count: 1 }]);
      await dispatcher.processDueDeliveries();
      expect(http.receipts).toHaveLength(before + 1);
      const count = await db.runtime.query(
        'SELECT count(*)::text AS count FROM settlement_handoffs WHERE platform_handoff_id = $1',
        [id],
      );
      expect(count.rows[0].count).toBe('1');
    },
  );

  test.each([
    '"displayAmount":1e2',
    '"displayAmount":"1e2"',
    '"displayAmount":9999999999999.9901',
    '"displayAmount":"10000000000000"',
    '"displayAmount":"1.00","assetAmount":"0.0000001"',
    '"displayAmount":"1.00","assetAmount":"1000000000.000000"',
  ])('rejects invalid monetary intent before database writes: %s', async (amounts) => {
    const before = await db.runtime.query(
      'SELECT count(*)::text AS count FROM settlement_handoffs',
    );
    const response = await http.post(
      body(`rejected-${amounts.length}`, amounts),
      `rejected-${amounts}`,
    );
    expect(response.status).toBe(400);
    const after = await db.runtime.query('SELECT count(*)::text AS count FROM settlement_handoffs');
    expect(after.rows).toEqual(before.rows);
  });

  test('rejects a changed signed body before persistence', async () => {
    const signed = body('tampered-signature', '"displayAmount":"1.00"');
    const changed = body('tampered-signature', '"displayAmount":"2.00"');
    const response = await http.post(changed, 'tampered-signature', 'platform-main', signed);
    expect(response.status).toBe(401);
    const rows = await db.runtime.query(
      "SELECT handoff_id FROM settlement_handoffs WHERE platform_handoff_id = 'tampered-signature'",
    );
    expect(rows.rows).toHaveLength(0);
  });

  test('contains an invalid stored callback amount before JSON rounding or delivery', async () => {
    const response = await http.post(
      body('stored-callback', '"displayAmount":"1.00"'),
      'stored-callback',
    );
    const payload = (await response.json()) as { data: { handoffId: string } };
    const queued = await http.service.recordExecutionEvent({
      handoffId: payload.data.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      observedAt: new Date().toISOString(),
      requestId: 'stored-callback',
      sourceApiKeyId: 'platform-main',
    });
    const before = http.receipts.length;
    // JSONB preserves this excess scale; JSON.parse would round it into the allowed range.
    await db.owner.query(
      "UPDATE settlement_callback_deliveries SET request_body = jsonb_set(request_body, '{displayAmount}', '9999999999999.9901'::jsonb) WHERE delivery_id = $1",
      [queued.callbackDelivery.deliveryId],
    );
    const dispatcher = new SettlementCallbackDispatcher(
      http.config,
      createPostgresSettlementStore(db.runtime),
    );
    try {
      await expect(dispatcher.processDueDeliveries()).rejects.toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(http.receipts).toHaveLength(before);
      const state = await db.runtime.query(
        'SELECT status, attempt_count FROM settlement_callback_deliveries WHERE delivery_id = $1',
        [queued.callbackDelivery.deliveryId],
      );
      expect(state.rows).toEqual([{ status: 'pending', attempt_count: 0 }]);
    } finally {
      // Restore the fixture; production corrections require independent authorization.
      await db.owner.query(
        'UPDATE settlement_callback_deliveries SET request_body = $1::jsonb WHERE delivery_id = $2',
        [JSON.stringify(queued.callbackDelivery.requestBody), queued.callbackDelivery.deliveryId],
      );
    }
    await dispatcher.processDueDeliveries();
    expect(http.receipts).toHaveLength(before + 1);
  });
});
