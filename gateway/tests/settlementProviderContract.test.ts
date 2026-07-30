/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createSchemaValidator } from '../src/openapi/contract';
import type { OpenApiSpec } from '../src/openapi/spec';

const specPath = path.resolve(__dirname, '../../docs/api/cotsel-settlement-provider.openapi.yml');
const fixturePath = path.resolve(
  __dirname,
  '../../docs/api/fixtures/cotsel-settlement-callback.v1.json',
);

function loadProviderContract(): OpenApiSpec {
  return yaml.load(fs.readFileSync(specPath, 'utf8')) as OpenApiSpec;
}

function loadFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

describe('Cotsel settlement provider callback contract', () => {
  const validate = createSchemaValidator(
    loadProviderContract(),
    '#/components/schemas/CotselSettlementCallbackV1',
  );

  test('accepts the pinned matched-reconciliation fixture', () => {
    expect(validate(loadFixture())).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('rejects matched reconciliation without observed amount evidence', () => {
    const payload = loadFixture();
    payload.metadata = {};

    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '/metadata',
          keyword: 'required',
          params: { missingProperty: 'reconciliationEvidence' },
        }),
      ]),
    );
  });

  test('rejects amounts that are numeric, negative or more precise than cents', () => {
    const payload = loadFixture();
    payload.metadata = {
      reconciliationEvidence: {
        schemaVersion: 'cotsel.settlement-observed-amounts.v1',
        observedAmounts: {
          supplierPayoutUsd: 950,
          treasuryClaimableUsd: '-1.00',
          buyerRefundUsd: '0.001',
        },
      },
    };

    expect(validate(payload)).toBe(false);
  });

  test('rejects unversioned extensions to reconciliation evidence', () => {
    const payload = loadFixture();
    const metadata = payload.metadata as Record<string, unknown>;
    const evidence = metadata.reconciliationEvidence as Record<string, unknown>;
    evidence.confirmedBy = 'provider-enum';

    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '/metadata/reconciliationEvidence',
          keyword: 'additionalProperties',
        }),
      ]),
    );
  });

  test('rejects a reconciliation callback without a numeric on-chain trade ID', () => {
    const payload = loadFixture();
    payload.tradeId = 'trade-8412';

    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '/tradeId',
          keyword: 'pattern',
        }),
      ]),
    );
  });

  test('rejects a reconciliation callback without a canonical release transaction hash', () => {
    const payload = loadFixture();
    payload.txHash = null;

    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '/txHash',
        }),
      ]),
    );
  });

  test('does not apply fund-release evidence rules to gasless trade-lock callbacks', () => {
    const payload = loadFixture();
    payload.platformHandoffId = 'gasless-sponsorship:sponsor-1';
    payload.tradeId = 'order:42';
    payload.phase = 'gasless_create_trade';
    payload.latestEventType = 'confirmed';
    payload.metadata = {};

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
