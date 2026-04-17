import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';

type TreasuryQueries = typeof import('../src/database/queries');
type TreasuryConnection = typeof import('../src/database/connection');
type TreasuryControllerModule = typeof import('../src/api/controller');
type TreasuryRoutesModule = typeof import('../src/api/routes');

async function createFreshTreasuryDatabase() {
  const dbName = `treasury_bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: 'postgres',
    user: process.env.DB_MIGRATION_USER || process.env.DB_USER || 'postgres',
    password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD || 'postgres',
  });

  await admin.query(`CREATE DATABASE "${dbName}"`);

  return {
    dbName,
    async cleanup() {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    },
  };
}

describe('treasury partner handoff persistence (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;

  beforeAll(async () => {
    const provisioned = await createFreshTreasuryDatabase();
    cleanup = provisioned.cleanup;

    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_NAME = provisioned.dbName;
    process.env.DB_USER = process.env.DB_USER || 'postgres';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
    process.env.DB_MIGRATION_USER = process.env.DB_MIGRATION_USER || process.env.DB_USER;
    process.env.DB_MIGRATION_PASSWORD =
      process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD;
    process.env.PORT = process.env.PORT || '3200';
    process.env.INDEXER_GRAPHQL_URL =
      process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

    jest.resetModules();
    const migrations = await import('../src/database/migrations');
    await migrations.runMigrations();
    queries = await import('../src/database/queries');
    connection = await import('../src/database/connection');
  });

  afterAll(async () => {
    await connection?.closeConnection();
    await cleanup?.();
  });

  it('persists Bridge treasury handoff evidence with idempotent replay and conflict rejection', async () => {
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: 'treasury-bridge-handoff-proof',
      tradeId: 'trade-bridge-handoff-proof',
      txHash: '0xbridgeproof',
      blockNumber: 42,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: { source: 'postgres-remediation-proof' },
    });

    await queries.appendPayoutState({
      ledgerEntryId: entry.id,
      state: 'READY_FOR_EXTERNAL_HANDOFF',
      actor: 'postgres-test',
      note: 'Eligible for Bridge handoff proof',
    });

    const handoffInput = {
      ledgerEntryId: entry.id,
      partnerCode: 'bridge' as const,
      handoffReference: 'bridge-handoff-proof',
      partnerStatus: 'SUBMITTED' as const,
      transferReference: 'bridge-transfer-proof',
      destinationExternalAccountId: 'external-account-proof',
      sourceAmount: '125.00',
      sourceCurrency: 'USDC',
      destinationAmount: '125.00',
      destinationCurrency: 'USD',
      actor: 'Treasury Operator',
      note: 'Bridge execution handoff recorded by Cotsel',
      initiatedAt: new Date('2026-04-16T08:05:00.000Z'),
      metadata: { adapter: 'bridge' },
    };

    const createdHandoff = await queries.upsertTreasuryPartnerHandoff(handoffInput);
    expect(createdHandoff.created).toBe(true);
    expect(createdHandoff.idempotentReplay).toBe(false);
    expect(createdHandoff.handoff.partner_code).toBe('bridge');
    expect(createdHandoff.handoff.transfer_reference).toBe('bridge-transfer-proof');

    const replayedHandoff = await queries.upsertTreasuryPartnerHandoff(handoffInput);
    expect(replayedHandoff.created).toBe(false);
    expect(replayedHandoff.idempotentReplay).toBe(true);
    await expect(
      queries.upsertTreasuryPartnerHandoff({
        ...handoffInput,
        partnerStatus: 'FAILED',
      }),
    ).rejects.toThrow(/conflicting payload/i);

    const evidenceInput = {
      ledgerEntryId: entry.id,
      partnerCode: 'bridge' as const,
      providerEventId: 'bridge-event-proof',
      eventType: 'transfer.updated.status_transitioned',
      partnerStatus: 'COMPLETED' as const,
      payoutReference: 'bridge-payout-proof',
      transferReference: 'bridge-transfer-proof',
      destinationExternalAccountId: 'external-account-proof',
      bankReference: 'bank-proof',
      bankState: 'CONFIRMED' as const,
      evidenceReference: 'bridge-receipt-proof',
      observedAt: new Date('2026-04-16T08:10:00.000Z'),
      metadata: { webhookCategory: 'transfer' },
    };

    const createdEvidence = await queries.appendTreasuryPartnerHandoffEvidence(evidenceInput);
    expect(createdEvidence.created).toBe(true);
    expect(createdEvidence.idempotentReplay).toBe(false);
    expect(createdEvidence.handoff.partner_status).toBe('COMPLETED');
    expect(createdEvidence.event.provider_event_id).toBe('bridge-event-proof');

    const storedHandoff = await queries.getTreasuryPartnerHandoffByLedgerEntryId(entry.id);
    expect(storedHandoff?.partner_status).toBe('COMPLETED');
    expect(storedHandoff?.destination_external_account_id).toBe('external-account-proof');

    const replayedEvidence = await queries.appendTreasuryPartnerHandoffEvidence(evidenceInput);
    expect(replayedEvidence.created).toBe(false);
    expect(replayedEvidence.idempotentReplay).toBe(true);
    await expect(
      queries.appendTreasuryPartnerHandoffEvidence({
        ...evidenceInput,
        partnerStatus: 'FAILED',
      }),
    ).rejects.toThrow(/conflicting payload/i);
  });
});

describe('treasury partner handoff routes (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let connection: TreasuryConnection;
  let queries: TreasuryQueries;
  let TreasuryControllerCtor: TreasuryControllerModule['TreasuryController'];
  let createRouterFn: TreasuryRoutesModule['createRouter'];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const provisioned = await createFreshTreasuryDatabase();
    cleanup = provisioned.cleanup;

    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_NAME = provisioned.dbName;
    process.env.DB_USER = process.env.DB_USER || 'postgres';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
    process.env.DB_MIGRATION_USER = process.env.DB_MIGRATION_USER || process.env.DB_USER;
    process.env.DB_MIGRATION_PASSWORD =
      process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD;
    process.env.PORT = process.env.PORT || '3200';
    process.env.INDEXER_GRAPHQL_URL =
      process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

    jest.resetModules();
    const migrations = await import('../src/database/migrations');
    await migrations.runMigrations();
    queries = await import('../src/database/queries');
    connection = await import('../src/database/connection');
    ({ TreasuryController: TreasuryControllerCtor } = await import('../src/api/controller'));
    ({ createRouter: createRouterFn } = await import('../src/api/routes'));

    const app = express();
    app.use(express.json());
    app.use('/api/treasury/v1', createRouterFn(new TreasuryControllerCtor()));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await connection?.closeConnection();
    await cleanup?.();
  });

  it('persists and replays Bridge handoff evidence through the real treasury routes', async () => {
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: 'treasury-bridge-route-proof',
      tradeId: 'trade-bridge-route-proof',
      txHash: '0xbridgerouteproof',
      blockNumber: 43,
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '150000000',
      sourceTimestamp: new Date('2026-04-17T08:00:00.000Z'),
      metadata: { source: 'postgres-route-proof' },
    });

    await queries.appendPayoutState({
      ledgerEntryId: entry.id,
      state: 'READY_FOR_EXTERNAL_HANDOFF',
      actor: 'postgres-test',
      note: 'Eligible for Bridge handoff route proof',
    });

    const handoffBody = {
      partnerCode: 'bridge',
      handoffReference: 'bridge-route-handoff-proof',
      partnerStatus: 'SUBMITTED',
      transferReference: 'bridge-route-transfer-proof',
      destinationExternalAccountId: 'external-account-route-proof',
      sourceAmount: '150.00',
      sourceCurrency: 'USDC',
      destinationAmount: '150.00',
      destinationCurrency: 'USD',
      actor: 'Treasury Operator',
      note: 'Bridge execution handoff recorded through treasury route',
      initiatedAt: '2026-04-17T08:05:00.000Z',
      metadata: { adapter: 'bridge', source: 'route-proof' },
    };

    const createdHandoffResponse = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/${entry.id}/partner-handoff`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handoffBody),
      },
    );
    expect(createdHandoffResponse.status).toBe(200);
    const createdHandoffPayload = (await createdHandoffResponse.json()) as {
      success: boolean;
      data: {
        created: boolean;
        idempotentReplay: boolean;
        handoff: { partner_code: string; handoff_reference: string };
      };
    };
    expect(createdHandoffPayload.data.created).toBe(true);
    expect(createdHandoffPayload.data.idempotentReplay).toBe(false);
    expect(createdHandoffPayload.data.handoff.partner_code).toBe('bridge');

    const replayedHandoffResponse = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/${entry.id}/partner-handoff`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handoffBody),
      },
    );
    expect(replayedHandoffResponse.status).toBe(200);
    const replayedHandoffPayload = (await replayedHandoffResponse.json()) as {
      data: { created: boolean; idempotentReplay: boolean };
    };
    expect(replayedHandoffPayload.data.created).toBe(false);
    expect(replayedHandoffPayload.data.idempotentReplay).toBe(true);

    const evidenceBody = {
      partnerCode: 'bridge',
      providerEventId: 'bridge-route-event-proof',
      eventType: 'transfer.updated.status_transitioned',
      partnerStatus: 'COMPLETED',
      payoutReference: 'bridge-route-payout-proof',
      transferReference: 'bridge-route-transfer-proof',
      destinationExternalAccountId: 'external-account-route-proof',
      bankReference: 'bank-route-proof',
      bankState: 'CONFIRMED',
      evidenceReference: 'bridge-route-receipt-proof',
      observedAt: '2026-04-17T08:10:00.000Z',
      metadata: { webhookCategory: 'transfer' },
    };

    const createdEvidenceResponse = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/${entry.id}/partner-handoff/evidence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evidenceBody),
      },
    );
    expect(createdEvidenceResponse.status).toBe(200);
    const createdEvidencePayload = (await createdEvidenceResponse.json()) as {
      data: {
        created: boolean;
        idempotentReplay: boolean;
        handoff: { partner_status: string };
        event: { provider_event_id: string };
      };
    };
    expect(createdEvidencePayload.data.created).toBe(true);
    expect(createdEvidencePayload.data.idempotentReplay).toBe(false);
    expect(createdEvidencePayload.data.handoff.partner_status).toBe('COMPLETED');
    expect(createdEvidencePayload.data.event.provider_event_id).toBe('bridge-route-event-proof');

    const readResponse = await fetch(
      `${baseUrl}/api/treasury/v1/entries/${entry.id}/partner-handoff`,
    );
    expect(readResponse.status).toBe(200);
    const readPayload = (await readResponse.json()) as {
      data: {
        handoff: { handoff_reference: string; partner_status: string };
        events: Array<{ provider_event_id: string }>;
      };
    };
    expect(readPayload.data.handoff.handoff_reference).toBe('bridge-route-handoff-proof');
    expect(readPayload.data.handoff.partner_status).toBe('COMPLETED');
    expect(readPayload.data.events).toHaveLength(1);
    expect(readPayload.data.events[0].provider_event_id).toBe('bridge-route-event-proof');

    const conflictingEvidenceResponse = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/${entry.id}/partner-handoff/evidence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...evidenceBody,
          partnerStatus: 'FAILED',
        }),
      },
    );
    expect(conflictingEvidenceResponse.status).toBe(409);
    const conflictingEvidencePayload = (await conflictingEvidenceResponse.json()) as {
      error: { code: string; message: string };
      code: string;
    };
    expect(conflictingEvidencePayload.code).toBe('BANK_PAYOUT_CONFLICT');
  });
});
