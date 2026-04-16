const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: mockPoolQuery,
  },
}));

import {
  addSweepBatchEntry,
  createAccountingPeriod,
  createSweepBatch,
  updateSweepBatchStatus,
  upsertTreasuryClaimEvent,
  upsertPartnerHandoff,
} from '../src/database/queries';

describe('treasury accounting control queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('creates accounting periods as OPEN by default', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          period_key: '2026-Q2',
          status: 'OPEN',
        },
      ],
    });

    const period = await createAccountingPeriod({
      periodKey: '2026-Q2',
      startsAt: new Date('2026-04-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: 'finance-1',
    });

    expect(mockPoolQuery.mock.calls[0][0]).toContain('INSERT INTO accounting_periods');
    expect(mockPoolQuery.mock.calls[0][1][3]).toBe('OPEN');
    expect(period.status).toBe('OPEN');
  });

  it('creates sweep batches only for open periods', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 5, status: 'OPEN' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, batch_key: 'batch-1', status: 'DRAFT' }],
      })
      .mockResolvedValueOnce({});

    const batch = await createSweepBatch({
      batchKey: 'batch-1',
      accountingPeriodId: 5,
      assetSymbol: 'USDC',
      expectedTotalRaw: '1000',
      createdBy: 'operator-1',
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[2][0]).toContain('INSERT INTO sweep_batches');
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(batch.status).toBe('DRAFT');
  });

  it('blocks duplicate active ledger allocation across sweep batches', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            status: 'DRAFT',
            accounting_period_status: 'OPEN',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 99, amount_raw: '1000' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 44, ledger_entry_id: 99 }],
      })
      .mockResolvedValueOnce({});

    await expect(
      addSweepBatchEntry({
        sweepBatchId: 10,
        ledgerEntryId: 99,
        allocatedBy: 'operator-1',
      }),
    ).rejects.toThrow('Ledger entry is already allocated to an active sweep batch');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('requires matched sweep evidence before external handoff can be recorded', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 10, matched_sweep_tx_hash: null, matched_swept_at: null }],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertPartnerHandoff({
        sweepBatchId: 10,
        partnerName: 'partner-x',
        partnerReference: 'partner-ref-1',
        handoffStatus: 'SUBMITTED',
      }),
    ).rejects.toThrow('External handoff requires matched on-chain treasury claim evidence');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('blocks self-approval by the batch preparer', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            status: 'PENDING_APPROVAL',
            created_by: 'operator-1',
            approval_requested_by: 'operator-1',
            approved_by: null,
            executed_by: null,
            closed_at: null,
            closed_by: null,
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      updateSweepBatchStatus({
        batchId: 10,
        status: 'APPROVED',
        actor: 'operator-1',
      }),
    ).rejects.toThrow('Sweep batch approval requires a different actor than preparation');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('allows approval by a second actor', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            status: 'PENDING_APPROVAL',
            created_by: 'operator-1',
            approval_requested_by: 'operator-1',
            approved_by: null,
            executed_by: null,
            closed_at: null,
            closed_by: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, status: 'APPROVED', approved_by: 'approver-2' }],
      })
      .mockResolvedValueOnce({});

    const result = await updateSweepBatchStatus({
      batchId: 10,
      status: 'APPROVED',
      actor: 'approver-2',
    });

    expect(result.status).toBe('APPROVED');
    expect(result.approved_by).toBe('approver-2');
  });

  it('blocks treasury claim evidence reuse across sweep batches', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 55, matched_sweep_batch_id: 22, tx_hash: '0xclaim' }],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertTreasuryClaimEvent({
        sourceEventId: 'event-1',
        matchedSweepBatchId: 10,
        txHash: '0xclaim',
        blockNumber: 101,
        observedAt: new Date('2026-04-15T00:00:00.000Z'),
        treasuryIdentity: '0xtreasury',
        payoutReceiver: '0xpayout',
        amountRaw: '125000000',
      }),
    ).rejects.toThrow('Treasury claim event is already matched to a different sweep batch');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
