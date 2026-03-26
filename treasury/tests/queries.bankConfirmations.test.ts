const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    connect: mockPoolConnect,
    query: jest.fn(),
  },
}));

import {
  BankPayoutConflictError,
  createBankPayoutPayloadHash,
  normalizeBankPayoutConfirmationInput,
} from '../src/core/bankPayout';
import { upsertBankPayoutConfirmation } from '../src/database/queries';

describe('upsertBankPayoutConfirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('writes a new bank confirmation when payout is already processing', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 11 }],
      })
      .mockResolvedValueOnce({
        rows: [{ state: 'PROCESSING' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 1, bank_reference: 'bank-1', bank_state: 'CONFIRMED' }],
      })
      .mockResolvedValueOnce({});

    const result = await upsertBankPayoutConfirmation({
      ledgerEntryId: 11,
      payoutReference: 'payout-1',
      bankReference: 'bank-1',
      bankState: 'CONFIRMED',
      confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
      source: 'bank:webhook',
      actor: 'Treasury Operator',
    });

    expect(result.created).toBe(true);
    expect(result.idempotentReplay).toBe(false);
    expect(mockClientQuery.mock.calls[4][0]).toContain('INSERT INTO bank_payout_confirmations');
  });

  it('treats identical bank reference payloads as idempotent replay', async () => {
    const payloadHash = createBankPayoutPayloadHash(
      normalizeBankPayoutConfirmationInput({
        ledgerEntryId: 11,
        payoutReference: 'payout-1',
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    );

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            bank_reference: 'bank-1',
            payload_hash: payloadHash,
          },
        ],
      })
      .mockResolvedValueOnce({});

    const result = await upsertBankPayoutConfirmation({
      ledgerEntryId: 11,
      payoutReference: 'payout-1',
      bankReference: 'bank-1',
      bankState: 'CONFIRMED',
      confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
      source: 'bank:webhook',
      actor: 'Treasury Operator',
    });

    expect(result.created).toBe(false);
    expect(result.idempotentReplay).toBe(true);
  });

  it('rejects duplicate bank references with conflicting payloads', async () => {
    const payloadHash = createBankPayoutPayloadHash(
      normalizeBankPayoutConfirmationInput({
        ledgerEntryId: 11,
        payoutReference: 'payout-1',
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    );

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            bank_reference: 'bank-1',
            payload_hash: payloadHash.replace(/^./u, payloadHash[0] === 'a' ? 'b' : 'a'),
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertBankPayoutConfirmation({
        ledgerEntryId: 11,
        payoutReference: 'payout-1',
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    ).rejects.toBeInstanceOf(BankPayoutConflictError);
  });

  it('blocks invalid bank confirmation transitions before insert', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 11 }],
      })
      .mockResolvedValueOnce({
        rows: [{ state: 'READY_FOR_PAYOUT' }],
      })
      .mockResolvedValueOnce({});

    await expect(
      upsertBankPayoutConfirmation({
        ledgerEntryId: 11,
        payoutReference: 'payout-1',
        bankReference: 'bank-2',
        bankState: 'CONFIRMED',
        confirmedAt: new Date('2026-03-26T00:00:00.000Z'),
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    ).rejects.toThrow('Bank confirmation is not valid while payout state is READY_FOR_PAYOUT');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
