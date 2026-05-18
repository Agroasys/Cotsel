const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();
// Intentionally fixed timestamp for deterministic, time-based test behavior.
const FIXED_TEST_DATE = new Date('2024-01-01T00:00:00.000Z');
const OBSERVATION_DELAY_MS = 15 * 60 * 1000;

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import {
  createTreasuryPartnerHandoffEvidencePayloadHash,
  createTreasuryPartnerHandoffPayloadHash,
  TreasuryPartnerHandoffConflictError,
  type TreasuryPartnerHandoffEvidencePayloadHashInput,
  type TreasuryPartnerHandoffPayloadHashInput,
} from '../src/core/treasuryPartnerHandoff';
import {
  appendTreasuryPartnerHandoffEvidence,
  upsertTreasuryPartnerHandoff,
} from '../src/database/queries';

function createHandoffPayloadHash(
  initiatedAtValue: Date,
  overrides: Partial<TreasuryPartnerHandoffPayloadHashInput> = {},
) {
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
    initiatedAt: initiatedAtValue,
    metadata: {},
    ...overrides,
  });
}

function createEvidencePayloadHash(
  observedAtValue: Date,
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
    observedAt: observedAtValue,
    metadata: {},
    ...overrides,
  });
}

function createHandoffTimeline() {
  const initiatedAt = new Date(FIXED_TEST_DATE);
  const observedAt = new Date(FIXED_TEST_DATE.getTime() + OBSERVATION_DELAY_MS);
  return { initiatedAt, observedAt };
}

type ExecutedQueryCall = [sql: string, params?: unknown];

function findExecutedQuery(sqlFragment: string): ExecutedQueryCall | undefined {
  return mockClientQuery.mock.calls.find(
    (call): call is ExecutedQueryCall =>
      Array.isArray(call) &&
      call.length >= 1 &&
      call.length <= 2 &&
      typeof call[0] === 'string' &&
      call[0].includes(sqlFragment),
  );
}

function getLastQueryInvocationOrder() {
  const lastInvocationOrder =
    mockClientQuery.mock.invocationCallOrder[mockClientQuery.mock.invocationCallOrder.length - 1];

  if (lastInvocationOrder === undefined) {
    throw new Error('Expected at least one query invocation');
  }

  return lastInvocationOrder;
}

describe('treasury partner handoff queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('throws when retrieving last query invocation order without any query invocations', () => {
    expect(() => getLastQueryInvocationOrder()).toThrow('Expected at least one query invocation');
  });

  it('writes a new treasury partner handoff inside one transaction', async () => {
    const { initiatedAt } = createHandoffTimeline();
    const latestEventPayloadHash = createHandoffPayloadHash(initiatedAt);

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
    const insertCall = findExecutedQuery('INSERT INTO treasury_partner_handoffs');
    expect(insertCall).toBeDefined();
    expect(insertCall?.[0]).toContain('INSERT INTO treasury_partner_handoffs');
    expect(insertCall?.[1]).toEqual([
      11,
      'bridge',
      'bridge-handoff-11',
      'SUBMITTED',
      'payout-11',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'Treasury Operator',
      null,
      null,
      latestEventPayloadHash,
      JSON.stringify({}),
      initiatedAt,
    ]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(mockClientQuery).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(mockClientRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
      getLastQueryInvocationOrder(),
    );
    expect(result.created).toBe(true);
    expect(result.idempotentReplay).toBe(false);
    expect(result.handoff.id).toBe(41);
  });

  it('rolls back and releases when a treasury partner handoff insert fails', async () => {
    const { initiatedAt } = createHandoffTimeline();
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
    expect(findExecutedQuery('INSERT INTO treasury_partner_handoffs')).toBeDefined();
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(mockClientRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
      getLastQueryInvocationOrder(),
    );
  });

  it('treats an identical treasury partner handoff payload as idempotent replay', async () => {
    const { initiatedAt } = createHandoffTimeline();
    const payloadHash = createHandoffPayloadHash(initiatedAt);

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
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockClientQuery).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting treasury partner handoff payloads for the same ledger entry', async () => {
    const { initiatedAt } = createHandoffTimeline();
    const existingPayloadHash = createHandoffPayloadHash(initiatedAt);

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
    ).rejects.toBeInstanceOf(TreasuryPartnerHandoffConflictError);

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('treats identical treasury partner evidence as idempotent replay', async () => {
    const { observedAt } = createHandoffTimeline();
    const payloadHash = createEvidencePayloadHash(observedAt);

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
    expect(replay.event.id).toBe(61);
    expect(replay.handoff.id).toBe(41);
    expect(replay.handoff.ledger_entry_id).toBe(11);
    expect(replay.handoff.partner_code).toBe('bridge');
    expect(replay.handoff.handoff_reference).toBe('bridge-handoff-11');
  });

  it('rejects conflicting treasury partner evidence', async () => {
    const { observedAt } = createHandoffTimeline();
    const existingPayloadHash = createEvidencePayloadHash(observedAt);

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

    const resultPromise = appendTreasuryPartnerHandoffEvidence({
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
    });

    await expect(resultPromise).rejects.toBeInstanceOf(TreasuryPartnerHandoffConflictError);
    await expect(resultPromise).rejects.toThrow(/conflicting payload/i);

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});
