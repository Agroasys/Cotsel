/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';

const transactionHash = `0x${'a'.repeat(64)}`;
const confirmedOutcome = {
  blockNumber: '1234',
  blockHash: `0x${'b'.repeat(64)}`,
  gasUsed: '210000',
  effectiveGasPriceWei: '2',
};

describe('Postgres gasless transaction outcome store', () => {
  test('accepts an identical terminal transition after another worker committed it', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            outcomeStatus: 'confirmed',
            failureCode: null,
            blockNumber: confirmedOutcome.blockNumber,
            blockHash: confirmedOutcome.blockHash,
            gasUsed: confirmedOutcome.gasUsed,
            effectiveGasPriceWei: confirmedOutcome.effectiveGasPriceWei,
          },
        ],
      });
    const store = createPostgresGaslessTransactionOutcomeRecorder({ query } as unknown as Pool);

    await expect(store.markConfirmed(transactionHash, confirmedOutcome)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('rejects conflicting terminal evidence instead of hiding provider disagreement', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            outcomeStatus: 'confirmed',
            failureCode: null,
            blockNumber: confirmedOutcome.blockNumber,
            blockHash: `0x${'c'.repeat(64)}`,
            gasUsed: confirmedOutcome.gasUsed,
            effectiveGasPriceWei: confirmedOutcome.effectiveGasPriceWei,
          },
        ],
      });
    const store = createPostgresGaslessTransactionOutcomeRecorder({ query } as unknown as Pool);

    await expect(store.markConfirmed(transactionHash, confirmedOutcome)).rejects.toThrow(
      'Invalid gasless transaction outcome transition',
    );
  });

  test('treats repeated unknown evidence as idempotent', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            outcomeStatus: 'broadcast_unknown',
            failureCode: 'RECOVERY_TRANSACTION_NOT_FOUND',
            blockNumber: null,
            blockHash: null,
            gasUsed: null,
            effectiveGasPriceWei: null,
          },
        ],
      });
    const store = createPostgresGaslessTransactionOutcomeRecorder({ query } as unknown as Pool);

    await expect(
      store.markBroadcastUnknown(transactionHash, 'RECOVERY_TRANSACTION_NOT_FOUND'),
    ).resolves.toBeUndefined();
  });
});
