/** SPDX-License-Identifier: Apache-2.0 */
// Cotsel#951: the gateway reads contained trades from the reconciliation
// database and verifies their signed evidence itself. Runs against real
// reconciliation migrations; the run is sealed the way finalizeRun seals it.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Server } from 'http';
import path from 'path';
import { Router } from 'express';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { createServer } from 'node:http';
import {
  buildRunManifest,
  findingDigest,
  loadContainmentEvidenceBundle,
  loadOpenContainmentEvidenceBundles,
  manifestBytes,
  parsePublicKeys,
  readRunEvidence,
} from '@agroasys/shared-db/reconciliationEvidence';
import { createApp } from '../src/app';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import {
  createContainmentEvidenceService,
  UNCONFIGURED_CONTAINMENT_EVIDENCE,
  type ContainmentEvidenceService,
} from '../src/core/containmentEvidence';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator } from '../src/openapi/contract';
import { createReconciliationContainmentRouter } from '../src/routes/reconciliationContainments';
import { testPostgresPort } from './helpers/userActionEnginePostgres';
import { freshStepUp } from './support/stepUp';
import { baseTestGatewayConfig } from './support/testConfig';

const describePostgres =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ||
  Boolean(process.env.SETTLEMENT_ACTIVITY_DATABASE_URL)
    ? describe
    : describe.skip;

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEYS = parsePublicKeys(
  JSON.stringify({
    'gateway-test-key': publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }),
);
const FINDING = {
  tradeId: '42',
  severity: 'CRITICAL',
  mismatchCode: 'AMOUNT_MISMATCH',
  comparedField: 'totalAmountLocked',
  onchainValue: '100',
  indexedValue: '101',
  details: {},
};

function sessionClient(role: 'admin' | null): AuthSessionClient {
  return {
    resolveSession: jest.fn().mockResolvedValue(
      role && {
        userId: 'uid-admin',
        accountId: 'acct-admin',
        walletAddress: null,
        role,
        capabilities: [],
        signerAuthorizations: [],
        authentication: freshStepUp(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ),
    checkReadiness: jest.fn(),
  };
}

async function serve(
  containmentEvidence: ContainmentEvidenceService,
  role: 'admin' | null = 'admin',
) {
  const router = Router();
  router.use(
    createReconciliationContainmentRouter({
      authSessionClient: sessionClient(role),
      config: baseTestGatewayConfig,
      containmentEvidence,
    }),
  );
  const app = createApp(baseTestGatewayConfig, {
    version: '0.1.0',
    commitSha: baseTestGatewayConfig.commitSha,
    buildTime: baseTestGatewayConfig.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1` };
}

describePostgres('reconciliation containments with verified evidence (Cotsel#951)', () => {
  jest.setTimeout(120_000);
  const spec = loadOpenApiSpec();
  const validateOne = createSchemaValidator(
    spec,
    '#/components/schemas/ReconciliationContainmentResponse',
  );
  const validateList = createSchemaValidator(
    spec,
    '#/components/schemas/ReconciliationContainmentListResponse',
  );
  const name = `recon_${randomUUID().replace(/-/g, '')}`;
  const connection = {
    host: '127.0.0.1',
    port: testPostgresPort(),
    user: 'postgres',
    password: 'postgres',
  };
  let owner: Pool;
  let service: ContainmentEvidenceService;
  let reconciliation: Server;
  // Applied to every reply before it leaves "reconciliation": a man in the middle.
  let alterReply: (body: unknown) => unknown = (body) => body;

  beforeAll(async () => {
    const admin = new Pool({ ...connection, database: 'postgres' });
    await admin.query(`CREATE ROLE ${name} NOLOGIN`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    owner = new Pool({
      ...connection,
      database: name,
      options: `-c app.service_name=reconciliation -c app.runtime_db_user=${name}`,
    });
    owner.on('error', () => undefined);
    await runVersionedMigrations({
      pool: owner,
      serviceName: 'reconciliation',
      manifestPath: path.resolve(__dirname, '../../reconciliation/src/database/migrations.json'),
      runtimeDbUser: name,
    });
    // A completed run with one finding, sealed in its completing transaction.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(
        `INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('daemon-1', 'DAEMON', 'RUNNING') RETURNING id`,
      );
      await client.query(
        `INSERT INTO reconcile_drifts (run_id, run_key, trade_id, severity, mismatch_code, compared_field, onchain_value, indexed_value, details)
         VALUES ($1, 'daemon-1', $2, $3, $4, $5, $6, $7, '{}')`,
        [
          run.rows[0].id,
          FINDING.tradeId,
          FINDING.severity,
          FINDING.mismatchCode,
          FINDING.comparedField,
          FINDING.onchainValue,
          FINDING.indexedValue,
        ],
      );
      await client.query(
        `UPDATE reconcile_runs SET status = 'COMPLETED', completed_at = NOW() AT TIME ZONE 'UTC', coverage_complete = true WHERE run_key = 'daemon-1'`,
      );
      const manifest = buildRunManifest((await readRunEvidence(client, 'daemon-1'))!, {
        keyId: 'gateway-test-key',
        rulesVersion: 'cotsel.reconciliation-risk-rules.v1',
        rulesDigest: 'test',
      });
      await client.query(
        `INSERT INTO reconcile_run_manifests (run_key, schema_version, manifest, signature, key_id)
         VALUES ('daemon-1', $1, $2::jsonb, $3, 'gateway-test-key')`,
        [
          manifest.schemaVersion,
          JSON.stringify(manifest),
          sign('sha256', manifestBytes(manifest), privateKey).toString('base64'),
        ],
      );
      await client.query(
        `INSERT INTO reconcile_trade_containments (trade_id, incident_reference, state, opened_run_key, qualifying_codes, evidence)
         VALUES ('42', 'RECON-20261124-AAAA0001', 'CONTAINED', 'daemon-1', ARRAY['AMOUNT_MISMATCH'], $1::jsonb)`,
        [
          JSON.stringify({
            rules: { version: 'cotsel.reconciliation-risk-rules.v1' },
            findings: [
              {
                digest: findingDigest({ runKey: 'daemon-1', ...FINDING }),
                mismatchCode: FINDING.mismatchCode,
                comparedField: FINDING.comparedField,
              },
            ],
          }),
        ],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // Stands in for reconciliation's internal service: the same loader serves
    // the same bundles (reconciliation/src/containmentEvidenceHttp.ts).
    reconciliation = createServer((req, res) => {
      const match = /^\/containments(?:\/([0-9]+))?$/u.exec(req.url ?? '');
      void (async () => {
        const body = match?.[1]
          ? await loadContainmentEvidenceBundle(owner, match[1])
          : { items: await loadOpenContainmentEvidenceBundles(owner) };
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body ? alterReply(body) : { error: 'containment_not_found' }));
      })();
    });
    await new Promise<void>((resolve) => reconciliation.listen(0, resolve));
    const address = reconciliation.address();
    if (!address || typeof address === 'string') throw new Error('no reconciliation address');
    service = createContainmentEvidenceService({
      baseUrl: `http://127.0.0.1:${address.port}`,
      publicKeys: KEYS,
      timeoutMs: 5000,
    });
  });

  afterAll(async () => {
    await service?.close();
    await new Promise((resolve) => reconciliation?.close(resolve));
    await owner?.end();
    const admin = new Pool({ ...connection, database: 'postgres' });
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${name}`);
    await admin.end();
  });

  it('lists and reads a verified containment, schema-valid', async () => {
    const { server, baseUrl } = await serve(service);
    try {
      const headers = { Authorization: 'Bearer sess-admin' };
      const list = await (
        await fetch(`${baseUrl}/reconciliation/containments`, { headers })
      ).json();
      expect(validateList(list)).toBe(true);
      expect(list.data.items).toHaveLength(1);
      const one = await fetch(`${baseUrl}/reconciliation/containments/42`, { headers });
      const body = await one.json();
      expect(one.status).toBe(200);
      expect(validateOne(body)).toBe(true);
      expect(body.data.evidence).toEqual({ status: 'verified', reason: null });
      expect(body.data.findings[0].status).toBe('verified');
      expect((await fetch(`${baseUrl}/reconciliation/containments/7`, { headers })).status).toBe(
        404,
      );
      expect((await fetch(`${baseUrl}/reconciliation/containments/x`, { headers })).status).toBe(
        400,
      );
    } finally {
      server.close();
    }
  });

  it('a reply altered in transit does not verify', async () => {
    alterReply = (body) => {
      const bundle = structuredClone(body) as {
        opening: { evidence: { findings: Array<{ indexedValue: string }> } };
      };
      bundle.opening.evidence.findings[0].indexedValue = '100';
      return bundle;
    };
    try {
      expect((await service.get('42'))?.evidence.status).toBe('failed');
    } finally {
      alterReply = (body) => body;
    }
    expect((await service.get('42'))?.evidence.status).toBe('verified');
  });

  it('is unavailable, never verified, when reconciliation cannot be reached', async () => {
    const offline = createContainmentEvidenceService({
      baseUrl: 'http://127.0.0.1:9',
      publicKeys: KEYS,
      timeoutMs: 1000,
    });
    await expect(offline.requireVerified('42')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('reports tampered evidence as failed and refuses a release on it', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE reconcile_drifts SET indexed_value = '100' WHERE trade_id = '42'`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const containment = await service.get('42');
    expect(containment?.evidence.status).toBe('failed');
    expect(containment?.findings[0].status).toBe('missing');
    await expect(service.requireVerified('42')).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reason: 'reconciliation_evidence_invalid' }),
    });
  });

  it('requires operator read access, and is unavailable when unconfigured', async () => {
    const anonymous = await serve(service, null);
    try {
      expect((await fetch(`${anonymous.baseUrl}/reconciliation/containments`)).status).toBe(401);
    } finally {
      anonymous.server.close();
    }
    const unconfigured = await serve(UNCONFIGURED_CONTAINMENT_EVIDENCE);
    try {
      const response = await fetch(`${unconfigured.baseUrl}/reconciliation/containments`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      expect(response.status).toBe(503);
    } finally {
      unconfigured.server.close();
    }
  });
});
