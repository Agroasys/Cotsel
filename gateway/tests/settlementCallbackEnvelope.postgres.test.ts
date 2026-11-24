/** SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { createPostgresSettlementStore } from '../src/core/settlementStore';
import { SettlementService } from '../src/core/settlementService';
import { baseTestGatewayConfig } from './support/testConfig';

const describePostgres = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL ? describe : describe.skip;

describePostgres('settlement callback event envelope', () => {
  test('stores the registered envelope and keeps the HTTP payload and retry identity unchanged', async () => {
    const db = await createUserActionEnginePostgres();
    try {
      const service = new SettlementService(
        {
          ...baseTestGatewayConfig,
          settlementCallbackEnabled: true,
          settlementCallbackUrl: 'https://callback.example.test',
          settlementCallbackApiKey: 'fixture-key',
          settlementCallbackApiSecret: 'fixture-secret',
        },
        createPostgresSettlementStore(db.runtime),
      );
      const handoff = await service.createHandoff({
        platformId: 'envelope-test',
        platformHandoffId: 'callback',
        tradeId: '42',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: '1.00',
        requestId: 'envelope-test',
        sourceApiKeyId: 'fixture-key',
      });
      const queued = await service.recordExecutionEvent({
        handoffId: handoff.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        observedAt: new Date().toISOString(),
        requestId: 'envelope-test',
        sourceApiKeyId: 'fixture-key',
      });
      const id = queued.callbackDelivery.deliveryId;
      const read = async () =>
        (
          await db.runtime.query(
            'SELECT envelope, request_body FROM settlement_callback_deliveries WHERE delivery_id=$1',
            [id],
          )
        ).rows[0];
      const row = await read();
      expect(row.envelope).toEqual({
        eventId: row.request_body.eventId,
        type: 'cotsel.settlement-callback',
        schemaVersion: 'v1',
        producer: 'gateway',
        settlementId: '42',
        orderingKey: '42',
        occurredAt: row.request_body.observedAt,
        payload: row.request_body,
      });
      expect(row.request_body.contractVersion).toBe('cotsel.settlement-callback.v1');
      await db.runtime.query(
        'UPDATE settlement_callback_deliveries SET attempt_count=1 WHERE delivery_id=$1',
        [id],
      );
      expect(await read()).toEqual(row);
      await expect(
        db.owner.query(
          "UPDATE settlement_callback_deliveries SET envelope=jsonb_set(envelope, '{eventId}', '\"changed\"') WHERE delivery_id=$1",
          [id],
        ),
      ).rejects.toThrow(/immutable/);
      const registry = JSON.parse(
        readFileSync(path.resolve(__dirname, '../../docs/api/events/registry.json'), 'utf8'),
      );
      expect(
        registry.contracts.find(
          (entry: { id: string }) => entry.id === row.request_body.contractVersion,
        ).envelope,
      ).toEqual({
        type: row.envelope.type,
        version: 'v1',
        producer: 'gateway',
        outbox: 'settlement_callback_deliveries',
      });
    } finally {
      await db.close();
    }
  });
});
