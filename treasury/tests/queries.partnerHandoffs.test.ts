const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import { BankPayoutConflictError } from '../src/core/bankPayout';
import {
  createTreasuryPartnerHandoffEvidencePayloadHash,
  createTreasuryPartnerHandoffPayloadHash,
  type TreasuryPartnerHandoffEvidencePayloadHashInput,
  type TreasuryPartnerHandoffPayloadHashInput,
} from '../src/core/treasuryPartnerHandoff';
import {
  appendTreasuryPartnerHandoffEvidence,
  upsertTreasuryPartnerHandoff,
} from '../src/database/queries';

const baseNow = new Date();
const initiatedAt = new Date(baseNow.getTime());
const observedAt = new Date(baseNow.getTime() + 15 * 60 * 1000);

function buildHandoffPayloadHash(overrides: Partial<TreasuryPartnerHandoffPayloadHashInput> = {}) {
  return createTreasuryPartnerHandoffPayloadHash({
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
    initiatedAt,
    metadata: {},
    ...overrides,
  });
}

function buildEvidencePayloadHash(
  overrides: Partial<TreasuryPartnerHandoffEvidencePayloadHashInput> = {},
) {
  return createTreasuryPartnerHandoffEvidencePayloadHash({
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
    observedAt,
    metadata: {},
    ...overrides,
  });
}

describe('treasury partner handoff queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('writes a new treasury partner handoff inside one transaction', async () => {
    const latestEventPayloadHash = buildHandoffPayloadHash();

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
            latest_event_payload_hash: latestEventPayloadHash,
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
      initiatedAt,
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[3][0]).toContain('INSERT INTO treasury_partner_handoffs');
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(mockClientQuery).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(mockClientRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockClientQuery.mock.invocationCallOrder[4],
    );
    expect(result.created).toBe(true);
    expect(result.idempotentReplay).toBe(false);
    expect(result.handoff.id).toBe(41);
  });

  it('rolls back and releases when a treasury partner handoff insert fails', async () => {
    const insertError = new Error('insert failed');

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ id: 11, trade_id: 'trade-1' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(insertError)
      .mockResolvedValueOnce({});

    await expect(
      upsertTreasuryPartnerHandoff({
        ledgerEntryId: 11,
        partnerCode: 'bridge',
        handoffReference: 'bridge-handoff-11',
        partnerStatus: 'SUBMITTED',
        payoutReference: 'payout-11',
        actor: 'Treasury Operator',
        initiatedAt,
      }),
    ).rejects.toThrow(insertError);

    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[3][0]).toContain('INSERT INTO treasury_partner_handoffs');
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(mockClientRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockClientQuery.mock.invocationCallOrder[4],
    );
  });

  it('treats an identical treasury partner handoff payload as idempotent replay', async () => {
    const payloadHash = buildHandoffPayloadHash();

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
      initiatedAt,
    });

    expect(result.created).toBe(false);
    expect(result.idempotentReplay).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting treasury partner handoff payloads for the same ledger entry', async () => {
    const existingPayloadHash = buildHandoffPayloadHash();

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
            latest_event_payload_hash: existingPayloadHash,
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
        initiatedAt,
      }),
    ).rejects.toBeInstanceOf(BankPayoutConflictError);
  });

  it('treats identical treasury partner evidence as idempotent replay', async () => {
    const payloadHash = buildEvidencePayloadHash();

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
      observedAt,
    });

    expect(replay.created).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
  });

  it('rejects conflicting treasury partner evidence', async () => {
    const existingPayloadHash = buildEvidencePayloadHash();

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 61,
            partner_handoff_id: 41,
            payload_hash: existingPayloadHash,
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
        observedAt,
      }),
    ).rejects.toBeInstanceOf(BankPayoutConflictError);
  });
});
