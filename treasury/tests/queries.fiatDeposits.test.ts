const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import { createFiatDepositPayloadHash, FiatDepositConflictError, normalizeFiatDepositInput } from '../src/core/fiatDeposit';
import { upsertFiatDepositReference } from '../src/database/queries';

describe('upsertFiatDepositReference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('writes a new fiat deposit reference and event in one transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 12,
            trade_id: 'trade-1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 90,
            ramp_reference: 'ramp-1',
            trade_id: 'trade-1',
            deposit_state: 'FUNDED',
            provider_event_id: 'provider-event-1',
            failure_class: null,
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await upsertFiatDepositReference({
      rampReference: 'ramp-1',
      tradeId: 'trade-1',
      ledgerEntryId: 12,
      depositState: 'FUNDED',
      sourceAmount: '100',
      currency: 'usd',
      expectedAmount: '100',
      expectedCurrency: 'usd',
      observedAt: new Date('2026-03-26T00:00:00.000Z'),
      providerEventId: 'provider-event-1',
      providerAccountRef: 'acct-1',
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[4][0]).toContain('INSERT INTO fiat_deposit_references');
    expect(mockClientQuery.mock.calls[5][0]).toContain('INSERT INTO fiat_deposit_events');
    expect(mockClientQuery).toHaveBeenNthCalledWith(7, 'COMMIT');
    expect(result.reference.id).toBe(90);
    expect(result.eventCreated).toBe(true);
    expect(result.idempotentReplay).toBe(false);
  });

  it('treats same provider event with identical payload as idempotent replay', async () => {
    const payloadHash = createFiatDepositPayloadHash(
      normalizeFiatDepositInput({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        depositState: 'FUNDED',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: new Date('2026-03-26T00:00:00.000Z'),
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    );

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            payload_hash: payloadHash,
            fiat_deposit_reference_id: 33,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 33,
            ramp_reference: 'ramp-1',
            trade_id: 'trade-1',
            provider_event_id: 'provider-event-1',
          },
        ],
      })
      .mockResolvedValueOnce({});

    const result = await upsertFiatDepositReference({
      rampReference: 'ramp-1',
      tradeId: 'trade-1',
      depositState: 'FUNDED',
      sourceAmount: '100',
      currency: 'USD',
      expectedAmount: '100',
      expectedCurrency: 'USD',
      observedAt: new Date('2026-03-26T00:00:00.000Z'),
      providerEventId: 'provider-event-1',
      providerAccountRef: 'acct-1',
    });

    expect(result.eventCreated).toBe(false);
    expect(result.idempotentReplay).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('classifies currency mismatch explicitly', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 12,
            trade_id: 'trade-1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 91,
            ramp_reference: 'ramp-2',
            trade_id: 'trade-1',
            deposit_state: 'FUNDED',
            provider_event_id: 'provider-event-2',
            failure_class: 'CURRENCY_MISMATCH',
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await upsertFiatDepositReference({
      rampReference: 'ramp-2',
      tradeId: 'trade-1',
      ledgerEntryId: 12,
      depositState: 'FUNDED',
      sourceAmount: '100',
      currency: 'EUR',
      expectedAmount: '100',
      expectedCurrency: 'USD',
      observedAt: new Date('2026-03-26T00:00:00.000Z'),
      providerEventId: 'provider-event-2',
      providerAccountRef: 'acct-1',
    });

    expect(mockClientQuery.mock.calls[4][1][11]).toBe('CURRENCY_MISMATCH');
    expect(result.reference.failure_class).toBe('CURRENCY_MISMATCH');
  });

  it('classifies reversed funding explicitly', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 12,
            trade_id: 'trade-1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 92,
            ramp_reference: 'ramp-3',
            trade_id: 'trade-1',
            deposit_state: 'REVERSED',
            provider_event_id: 'provider-event-3',
            failure_class: 'REVERSED_FUNDING',
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await upsertFiatDepositReference({
      rampReference: 'ramp-3',
      tradeId: 'trade-1',
      ledgerEntryId: 12,
      depositState: 'REVERSED',
      sourceAmount: '100',
      currency: 'USD',
      expectedAmount: '100',
      expectedCurrency: 'USD',
      observedAt: new Date('2026-03-26T00:00:00.000Z'),
      providerEventId: 'provider-event-3',
      providerAccountRef: 'acct-1',
      reversalReference: 'reversal-1',
    });

    expect(mockClientQuery.mock.calls[4][1][11]).toBe('REVERSED_FUNDING');
    expect(result.reference.failure_class).toBe('REVERSED_FUNDING');
  });

  it('keeps reversed funding classification even when the observed amount mismatches', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 12,
            trade_id: 'trade-1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 93,
            ramp_reference: 'ramp-4',
            trade_id: 'trade-1',
            deposit_state: 'REVERSED',
            provider_event_id: 'provider-event-4',
            failure_class: 'REVERSED_FUNDING',
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await upsertFiatDepositReference({
      rampReference: 'ramp-4',
      tradeId: 'trade-1',
      ledgerEntryId: 12,
      depositState: 'REVERSED',
      sourceAmount: '90',
      currency: 'USD',
      expectedAmount: '100',
      expectedCurrency: 'USD',
      observedAt: new Date('2026-03-26T00:00:00.000Z'),
      providerEventId: 'provider-event-4',
      providerAccountRef: 'acct-1',
      reversalReference: 'reversal-2',
    });

    expect(mockClientQuery.mock.calls[4][1][11]).toBe('REVERSED_FUNDING');
    expect(result.reference.failure_class).toBe('REVERSED_FUNDING');
  });

  it('rejects duplicate provider events with conflicting payloads', async () => {
    const payloadHash = createFiatDepositPayloadHash(
      normalizeFiatDepositInput({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        depositState: 'FUNDED',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: new Date('2026-03-26T00:00:00.000Z'),
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    );

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            payload_hash: payloadHash.replace(/^./u, payloadHash[0] === 'a' ? 'b' : 'a'),
            fiat_deposit_reference_id: 33,
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertFiatDepositReference({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        depositState: 'FUNDED',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: new Date('2026-03-26T00:00:00.000Z'),
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    ).rejects.toBeInstanceOf(FiatDepositConflictError);

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
