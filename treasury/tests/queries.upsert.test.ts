const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import { upsertLedgerEntryWithInitialState } from '../src/database/queries';

describe('upsertLedgerEntryWithInitialState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('writes ledger entry and initial lifecycle state in one transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            entry_key: 'evt-1:logistics',
            trade_id: 'trade-1',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    const result = await upsertLedgerEntryWithInitialState({
      entryKey: 'evt-1:logistics',
      tradeId: 'trade-1',
      txHash: '0xhash',
      blockNumber: 100,
      eventName: 'FundsReleasedStage1',
      componentType: 'LOGISTICS',
      amountRaw: '100',
      sourceTimestamp: new Date('2026-01-01T00:00:00.000Z'),
      metadata: { sourceEventId: 'evt-1' },
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[1][0]).toContain('INSERT INTO treasury_ledger_entries');
    expect(mockClientQuery.mock.calls[2][0]).toContain('INSERT INTO payout_lifecycle_events');
    expect(mockClientQuery.mock.calls[2][0]).toContain('WHERE NOT EXISTS');
    expect(mockClientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');

    expect(result.entry.id).toBe(42);
    expect(result.initialStateCreated).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back transaction when lifecycle insert fails', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            entry_key: 'evt-2:platform_fee',
            trade_id: 'trade-2',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('lifecycle insert failed'))
      .mockResolvedValueOnce({});

    await expect(
      upsertLedgerEntryWithInitialState({
        entryKey: 'evt-2:platform_fee',
        tradeId: 'trade-2',
        txHash: '0xhash2',
        blockNumber: 101,
        eventName: 'PlatformFeesPaidStage1',
        componentType: 'PLATFORM_FEE',
        amountRaw: '15',
        sourceTimestamp: new Date('2026-01-01T00:00:00.000Z'),
        metadata: { sourceEventId: 'evt-2' },
      }),
    ).rejects.toThrow('lifecycle insert failed');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});
