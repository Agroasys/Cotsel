/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { createServiceApiKeyLookup, createServiceAuthHeaders } from '../src/core/serviceAuth';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore } from '../src/core/settlementStore';
import { createSettlementRouter } from '../src/routes/settlement';
import { sendInProcessRequest } from './support/inProcessHttp';
import { baseTestGatewayConfig } from './support/testConfig';

const config: GatewayConfig = {
  ...baseTestGatewayConfig,
  settlementIngressEnabled: true,
  settlementServiceAuthApiKeysJson: JSON.stringify([
    { id: 'platform-main', secret: 'super-secret', active: true },
  ]),
};

const HANDOFF_PATH = '/api/dashboard-gateway/v1/settlement/handoffs';

function createTestApp() {
  const settlementStore = createInMemorySettlementStore();
  const router = Router();
  router.use(
    createSettlementRouter({
      config,
      settlementService: new SettlementService(config, settlementStore),
      settlementStore,
      nonceStore: createInMemoryNonceStore(),
      idempotencyStore: createInMemoryIdempotencyStore(),
      lookupServiceApiKey: createServiceApiKeyLookup(config.settlementServiceAuthApiKeysJson),
    }),
  );

  return createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });
}

let requestCounter = 0;

async function postHandoff(app: ReturnType<typeof createTestApp>, rawBody: string) {
  requestCounter += 1;
  const headers = createServiceAuthHeaders({
    apiKey: 'platform-main',
    apiSecret: 'super-secret',
    method: 'POST',
    path: HANDOFF_PATH,
    body: rawBody,
    nonce: `amount-nonce-${requestCounter}`,
  });

  const response = await sendInProcessRequest(app, {
    method: 'POST',
    path: HANDOFF_PATH,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `amount-idempotency-${requestCounter}`,
      ...headers,
    },
    body: rawBody,
  });

  return {
    status: response.status,
    payload: response.json<{
      data?: { handoffId: string; displayAmount: number; assetAmount: number | null };
      error?: { code: string; details?: Record<string, unknown> };
    }>(),
  };
}

function handoffBody(platformHandoffId: string, amounts: string): string {
  return `{"platformId":"agroasys-platform","platformHandoffId":"${platformHandoffId}","tradeId":"TRD-${platformHandoffId}","phase":"lock","settlementChannel":"cotsel_escrow","displayCurrency":"USD",${amounts},"assetSymbol":"USDC"}`;
}

describe('settlement handoff amount ingress', () => {
  test('accepts canonical decimal strings at the boundary and fractional limits', async () => {
    const app = createTestApp();
    const { status, payload } = await postHandoff(
      app,
      handoffBody(
        'amount-string-limit',
        '"displayAmount":"9999999999999.99","assetAmount":"999999999.999999"',
      ),
    );

    expect(status).toBe(202);
    expect(payload.data?.displayAmount).toBe(9999999999999.99);
    expect(payload.data?.assetAmount).toBe(999999999.999999);
  });

  test('keeps accepting exactly representable legacy JSON numbers', async () => {
    const app = createTestApp();
    const { status, payload } = await postHandoff(
      app,
      handoffBody('amount-legacy-number', '"displayAmount":1000.5,"assetAmount":12.345678'),
    );

    expect(status).toBe(202);
    expect(payload.data?.displayAmount).toBe(1000.5);
    expect(payload.data?.assetAmount).toBe(12.345678);
  });

  test.each([
    ['display scale overflow', '"displayAmount":12.345678', 'displayAmount', 'scale_exceeded'],
    [
      'asset scale overflow',
      '"displayAmount":"1","assetAmount":"1.0000001"',
      'assetAmount',
      'scale_exceeded',
    ],
    [
      'number beyond exact double range',
      '"displayAmount":12345678901234567.89',
      'displayAmount',
      'magnitude_exceeded',
    ],
    [
      'magnitude overflow',
      '"displayAmount":"10000000000000"',
      'displayAmount',
      'magnitude_exceeded',
    ],
    [
      'raw number rounded by the JSON parser',
      '"displayAmount":9999999999999.9901',
      'displayAmount',
      'scale_exceeded',
    ],
    [
      'raw asset number rounded by the JSON parser',
      '"displayAmount":"1","assetAmount":1.0000000000000001',
      'assetAmount',
      'scale_exceeded',
    ],
    ['raw exponent number', '"displayAmount":1e3', 'displayAmount', 'not_canonical_decimal'],
    ['raw negative zero', '"displayAmount":-0', 'displayAmount', 'not_canonical_decimal'],
    ['exponent string', '"displayAmount":"1e3"', 'displayAmount', 'not_canonical_decimal'],
    ['negative amount', '"displayAmount":"-0.01"', 'displayAmount', 'not_canonical_decimal'],
    ['boolean amount', '"displayAmount":true', 'displayAmount', 'invalid_type'],
  ])('rejects %s without rounding or persisting', async (_label, amounts, field, reason) => {
    const app = createTestApp();
    const { status, payload } = await postHandoff(
      app,
      handoffBody(`amount-reject-${field}`, amounts),
    );

    expect(status).toBe(400);
    expect(payload.error?.code).toBe('VALIDATION_ERROR');
    expect(payload.error?.details).toMatchObject({ field, reason });

    // A different valid amount under the same platform reference is accepted, so nothing was
    // persisted for the rejected request.
    const retry = await postHandoff(
      app,
      handoffBody(`amount-reject-${field}`, '"displayAmount":"7.00","assetAmount":"7"'),
    );
    expect(retry.status).toBe(202);
    expect(retry.payload.data?.displayAmount).toBe(7);
  });

  test('ignores nested metadata numbers when reading amount lexemes', async () => {
    const app = createTestApp();
    const { status, payload } = await postHandoff(
      app,
      handoffBody(
        'amount-nested-metadata',
        '"displayAmount":250.5,"metadata":{"displayAmount":1e3,"lines":[{"assetAmount":0.1234567}]}',
      ),
    );

    expect(status).toBe(202);
    expect(payload.data?.displayAmount).toBe(250.5);
  });

  test('returns the original handoff for an equivalent replay and rejects a changed amount', async () => {
    const app = createTestApp();
    const original = await postHandoff(
      app,
      handoffBody('amount-replay', '"displayAmount":"1000","assetAmount":"1000"'),
    );
    const equivalent = await postHandoff(
      app,
      handoffBody('amount-replay', '"displayAmount":1000.0,"assetAmount":"1000.000000"'),
    );
    const changed = await postHandoff(
      app,
      handoffBody('amount-replay', '"displayAmount":"1000.01","assetAmount":"1000"'),
    );

    expect(original.status).toBe(202);
    expect(equivalent.status).toBe(202);
    expect(equivalent.payload.data?.handoffId).toBe(original.payload.data?.handoffId);
    expect(changed.status).toBe(409);
    expect(changed.payload.error?.code).toBe('CONFLICT');
    expect(changed.payload.error?.details).toMatchObject({
      reason: 'handoff_monetary_intent_mismatch',
      fields: ['displayAmount'],
    });
  });
});
