import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  getLatestPayoutState: jest.fn(),
  appendPayoutState: jest.fn(),
  getTreasuryPartnerHandoffByLedgerEntryId: jest.fn(),
  upsertTreasuryPartnerHandoff: jest.fn(),
  appendTreasuryPartnerHandoffEvidence: jest.fn(),
  upsertBankPayoutConfirmation: jest.fn(),
}));

let createRouter: typeof import('../src/api/routes').createRouter;
let TreasuryController: typeof import('../src/api/controller').TreasuryController;
let queries: typeof import('../src/database/queries');

describe('treasury partner handoff routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    jest.resetModules();
    ({ createRouter } = await import('../src/api/routes'));
    ({ TreasuryController } = await import('../src/api/controller'));
    queries = await import('../src/database/queries');

    jest.mocked(queries.getLatestPayoutState).mockReset();
    jest.mocked(queries.appendPayoutState).mockReset();
    jest.mocked(queries.getTreasuryPartnerHandoffByLedgerEntryId).mockReset();
    jest.mocked(queries.upsertTreasuryPartnerHandoff).mockReset();
    jest.mocked(queries.appendTreasuryPartnerHandoffEvidence).mockReset();
    jest.mocked(queries.upsertBankPayoutConfirmation).mockReset();

    const app = express();
    app.use(express.json());
    app.use('/api/treasury/v1', createRouter(new TreasuryController()));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test('partner handoff route records a durable Bridge handoff and advances payout state', async () => {
    jest.mocked(queries.getLatestPayoutState).mockResolvedValue({
      id: 1,
      ledger_entry_id: 11,
      state: 'READY_FOR_PARTNER_SUBMISSION',
      note: null,
      actor: null,
      created_at: new Date('2026-04-16T08:00:00.000Z'),
    });
    jest.mocked(queries.upsertTreasuryPartnerHandoff).mockResolvedValue({
      handoff: {
        id: 51,
        ledger_entry_id: 11,
        partner_code: 'bridge',
        handoff_reference: 'bridge-handoff-11',
        partner_status: 'SUBMITTED',
      } as never,
      created: true,
      idempotentReplay: false,
    });
    jest.mocked(queries.appendPayoutState).mockResolvedValue({
      id: 2,
      ledger_entry_id: 11,
      state: 'AWAITING_PARTNER_UPDATE',
      note: 'Awaiting partner update',
      actor: 'Treasury Operator',
      created_at: new Date('2026-04-16T08:05:00.000Z'),
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/entries/11/partner-handoff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerCode: 'bridge',
        handoffReference: 'bridge-handoff-11',
        partnerStatus: 'SUBMITTED',
        actor: 'Treasury Operator',
        initiatedAt: '2026-04-16T08:05:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(queries.upsertTreasuryPartnerHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        partnerCode: 'bridge',
        handoffReference: 'bridge-handoff-11',
      }),
    );
    expect(queries.appendPayoutState).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        state: 'AWAITING_PARTNER_UPDATE',
      }),
    );
  });

  test('partner handoff evidence can attach bank finality and auto-complete the payout state', async () => {
    jest.mocked(queries.appendTreasuryPartnerHandoffEvidence).mockResolvedValue({
      handoff: {
        id: 51,
        ledger_entry_id: 11,
      } as never,
      event: {
        id: 61,
        provider_event_id: 'bridge-event-11',
      } as never,
      created: true,
      idempotentReplay: false,
    });
    jest.mocked(queries.upsertBankPayoutConfirmation).mockResolvedValue({
      confirmation: {
        id: 71,
        bank_reference: 'bank-11',
        bank_state: 'CONFIRMED',
      } as never,
      created: true,
      idempotentReplay: false,
    });
    jest.mocked(queries.getLatestPayoutState).mockResolvedValue({
      id: 2,
      ledger_entry_id: 11,
      state: 'AWAITING_PARTNER_UPDATE',
      note: null,
      actor: null,
      created_at: new Date('2026-04-16T08:10:00.000Z'),
    });
    jest.mocked(queries.appendPayoutState).mockResolvedValue({
      id: 3,
      ledger_entry_id: 11,
      state: 'PARTNER_REPORTED_COMPLETED',
      note: 'Auto-completed',
      actor: 'Treasury Operator',
      created_at: new Date('2026-04-16T08:15:00.000Z'),
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/entries/11/partner-handoff/evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerCode: 'bridge',
        providerEventId: 'bridge-event-11',
        eventType: 'transfer.updated',
        partnerStatus: 'COMPLETED',
        payoutReference: 'payout-11',
        bankReference: 'bank-11',
        bankState: 'CONFIRMED',
        evidenceReference: 'receipt-11',
        actor: 'Treasury Operator',
        source: 'bridge:webhook',
        observedAt: '2026-04-16T08:15:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(queries.appendTreasuryPartnerHandoffEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        providerEventId: 'bridge-event-11',
        bankState: 'CONFIRMED',
      }),
    );
    expect(queries.upsertBankPayoutConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        bankReference: 'bank-11',
        bankState: 'CONFIRMED',
      }),
    );
    expect(queries.appendPayoutState).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        state: 'PARTNER_REPORTED_COMPLETED',
      }),
    );
  });
});
