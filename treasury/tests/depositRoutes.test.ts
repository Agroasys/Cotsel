import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL = process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  upsertBankPayoutConfirmation: jest.fn(),
  upsertFiatDepositReference: jest.fn(),
}));

const { createRouter } = require('../src/api/routes') as typeof import('../src/api/routes');
const { TreasuryController } = require('../src/api/controller') as typeof import('../src/api/controller');
const { upsertBankPayoutConfirmation, upsertFiatDepositReference } = require('../src/database/queries') as typeof import('../src/database/queries');

const mockedUpsertBankPayoutConfirmation = upsertBankPayoutConfirmation as jest.MockedFunction<typeof upsertBankPayoutConfirmation>;
const mockedUpsertFiatDepositReference = upsertFiatDepositReference as jest.MockedFunction<typeof upsertFiatDepositReference>;

describe('treasury fiat deposit routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    mockedUpsertFiatDepositReference.mockReset();
    mockedUpsertBankPayoutConfirmation.mockReset();

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

  test('deposit endpoint persists normalized contract payload', async () => {
    mockedUpsertFiatDepositReference.mockResolvedValue({
      reference: {
        id: 1,
        ramp_reference: 'ramp-1',
      } as never,
      eventCreated: true,
      idempotentReplay: false,
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        ledgerEntryId: 11,
        depositState: 'FUNDED',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: '2026-03-26T00:00:00.000Z',
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockedUpsertFiatDepositReference).toHaveBeenCalledWith(
      expect.objectContaining({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        ledgerEntryId: 11,
        depositState: 'FUNDED',
        observedAt: new Date('2026-03-26T00:00:00.000Z'),
      }),
    );
  });

  test('invalid deposit state is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        depositState: 'DONE',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: '2026-03-26T00:00:00.000Z',
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: 'Invalid fiat deposit state',
      }),
    );
  });

  test('bank confirmation endpoint persists normalized contract payload', async () => {
    mockedUpsertBankPayoutConfirmation.mockResolvedValue({
      confirmation: {
        id: 1,
        bank_reference: 'bank-1',
      } as never,
      created: true,
      idempotentReplay: false,
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/entries/11/bank-confirmation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        payoutReference: 'payout-1',
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: '2026-03-26T00:00:00.000Z',
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockedUpsertBankPayoutConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: 11,
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
      }),
    );
  });

  test('invalid bank state is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries/11/bank-confirmation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        bankReference: 'bank-1',
        bankState: 'SETTLED',
        confirmedAt: '2026-03-26T00:00:00.000Z',
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: 'Invalid bank payout state',
      }),
    );
  });
});
