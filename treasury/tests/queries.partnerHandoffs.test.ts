const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

import { createHash } from 'crypto';

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import { BankPayoutConflictError } from '../src/core/bankPayout';
import {
  appendTreasuryPartnerHandoffEvidence,
  upsertTreasuryPartnerHandoff,
} from '../src/database/queries';

describe('treasury partner handoff queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('writes a new treasury partner handoff inside one transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 11, trade_id: 'trade-1' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 41,
            ledger_entry_id: 11,
            partner_code: 'bridge',
            handoff_reference: 'bridge-handoff-11',
            partner_status: 'SUBMITTED',
            latest_event_payload_hash: 'hash-1',
          },
        ],
      })
      .mockResolvedValueOnce({});

    const result = await upsertTreasuryPartnerHandoff({
      ledgerEntryId: 11,
      partnerCode: 'bridge',
      handoffReference: 'bridge-handoff-11',
      partnerStatus: 'SUBMITTED',
      payoutReference: 'payout-11',
      actor: 'Treasury Operator',
      initiatedAt: new Date('2026-04-16T08:00:00.000Z'),
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[3][0]).toContain('INSERT INTO treasury_partner_handoffs');
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(result.created).toBe(true);
    expect(result.idempotentReplay).toBe(false);
    expect(result.handoff.id).toBe(41);
  });

  it('treats an identical treasury partner handoff payload as idempotent replay', async () => {
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          ledgerEntryId: 11,
          partnerCode: 'bridge',
          handoffReference: 'bridge-handoff-11',
          partnerStatus: 'SUBMITTED',
          payoutReference: 'payout-11',
          transferReference: null,
          drainReference: null,
          destinationExternalAccountId: null,
          liquidationAddressId: null,
          sourceAmount: null,
          sourceCurrency: null,
          destinationAmount: null,
          destinationCurrency: null,
          actor: 'Treasury Operator',
          note: null,
          failureCode: null,
          initiatedAt: new Date('2026-04-16T08:00:00.000Z'),
          metadata: {},
        }),
      )
      .digest('hex');

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 11, trade_id: 'trade-1' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 41,
            ledger_entry_id: 11,
            partner_code: 'bridge',
            handoff_reference: 'bridge-handoff-11',
            partner_status: 'SUBMITTED',
            latest_event_payload_hash: payloadHash,
          },
        ],
      })
      .mockResolvedValueOnce({});

    const result = await upsertTreasuryPartnerHandoff({
      ledgerEntryId: 11,
      partnerCode: 'bridge',
      handoffReference: 'bridge-handoff-11',
      partnerStatus: 'SUBMITTED',
      payoutReference: 'payout-11',
      actor: 'Treasury Operator',
      initiatedAt: new Date('2026-04-16T08:00:00.000Z'),
    });

    expect(result.created).toBe(false);
    expect(result.idempotentReplay).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting treasury partner handoff payloads for the same ledger entry', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 11, trade_id: 'trade-1' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 41,
            ledger_entry_id: 11,
            partner_code: 'bridge',
            handoff_reference: 'bridge-handoff-11',
            partner_status: 'SUBMITTED',
            latest_event_payload_hash: 'different-hash',
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertTreasuryPartnerHandoff({
        ledgerEntryId: 11,
        partnerCode: 'bridge',
        handoffReference: 'bridge-handoff-11',
        partnerStatus: 'FAILED',
        payoutReference: 'payout-11',
        actor: 'Treasury Operator',
        initiatedAt: new Date('2026-04-16T08:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BankPayoutConflictError);
  });

  it('treats identical treasury partner evidence as idempotent replay and rejects conflicting evidence', async () => {
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          ledgerEntryId: 11,
          partnerCode: 'bridge',
          providerEventId: 'evt-11',
          eventType: 'transfer.updated',
          partnerStatus: 'COMPLETED',
          payoutReference: 'payout-11',
          transferReference: null,
          drainReference: null,
          destinationExternalAccountId: null,
          liquidationAddressId: null,
          bankReference: 'bank-11',
          bankState: 'CONFIRMED',
          evidenceReference: 'evidence-11',
          failureCode: null,
          observedAt: new Date('2026-04-16T08:15:00.000Z'),
          metadata: {},
        }),
      )
      .digest('hex');

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 61,
            partner_handoff_id: 41,
            payload_hash: payloadHash,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 41,
            ledger_entry_id: 11,
            partner_code: 'bridge',
            handoff_reference: 'bridge-handoff-11',
          },
        ],
      })
      .mockResolvedValueOnce({});

    const replay = await appendTreasuryPartnerHandoffEvidence({
      ledgerEntryId: 11,
      partnerCode: 'bridge',
      providerEventId: 'evt-11',
      eventType: 'transfer.updated',
      partnerStatus: 'COMPLETED',
      payoutReference: 'payout-11',
      bankReference: 'bank-11',
      bankState: 'CONFIRMED',
      evidenceReference: 'evidence-11',
      observedAt: new Date('2026-04-16T08:15:00.000Z'),
    });

    expect(replay.created).toBe(false);
    expect(replay.idempotentReplay).toBe(true);

    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 61,
            partner_handoff_id: 41,
            payload_hash: 'different-hash',
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      appendTreasuryPartnerHandoffEvidence({
        ledgerEntryId: 11,
        partnerCode: 'bridge',
        providerEventId: 'evt-11',
        eventType: 'transfer.updated',
        partnerStatus: 'FAILED',
        payoutReference: 'payout-11',
        bankReference: 'bank-11',
        bankState: 'REJECTED',
        evidenceReference: 'evidence-11',
        observedAt: new Date('2026-04-16T08:15:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BankPayoutConflictError);
  });
});
