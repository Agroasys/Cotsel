/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fixtures for the sweep execution matcher: an approved batch, the indexed
 * claim that should execute it, and a settlement chain whose receipt carries
 * the matching `TreasuryClaimed` log, encoded with the escrow ABI.
 */
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { FinalizedTransactionVerifier } from '../../src/core/finalizedTransaction';
import {
  stubChainReader,
  TEST_BLOCK_HASH,
  TEST_LOG_ADDRESS,
  type StubReceipt,
} from './chainCanonicality';

export const TREASURY = `0x${'aa'.repeat(20)}`;
export const PAYOUT = `0x${'bb'.repeat(20)}`;
export const OTHER = `0x${'dd'.repeat(20)}`;
export const SIGNER = `0x${'cc'.repeat(20)}`;

export function claimedLog(overrides?: { payoutReceiver?: string; amount?: bigint }) {
  const escrow = AgroasysEscrow__factory.createInterface();
  const { topics, data } = escrow.encodeEventLog('TreasuryClaimed', [
    TREASURY,
    overrides?.payoutReceiver ?? PAYOUT,
    overrides?.amount ?? 125000000n,
    SIGNER,
  ]);
  return { logTopics: topics, logData: data };
}

export const CANONICAL_CLAIM_RECEIPT: StubReceipt = {
  txHash: '0xclaim',
  blockNumber: 101,
  blockHash: TEST_BLOCK_HASH,
  logIndex: 0,
  logAddress: TEST_LOG_ADDRESS,
  ...claimedLog(),
};

export function claimVerifier(options?: {
  receipts?: StubReceipt[];
  finalizedBlockNumber?: number;
}) {
  return new FinalizedTransactionVerifier({
    provider: stubChainReader({
      receipts: options?.receipts ?? [CANONICAL_CLAIM_RECEIPT],
      finalizedBlockNumber: options?.finalizedBlockNumber,
    }),
  });
}

export const indexedClaim = {
  id: 'event-90',
  eventName: 'TreasuryClaimed' as const,
  txHash: '0xclaim',
  blockNumber: 101,
  logIndex: 0,
  timestamp: new Date('2026-04-15T11:00:00.000Z'),
  claimAmount: '125000000',
  treasuryIdentity: TREASURY,
  payoutReceiver: PAYOUT,
  triggeredBy: SIGNER,
};

export const batchDetailFixture = {
  batch: {
    id: 11,
    batch_key: 'batch-q2-001',
    accounting_period_id: 7,
    accounting_period_key: '2026-Q2',
    accounting_period_status: 'OPEN',
    asset_symbol: 'USDC',
    status: 'APPROVED',
    expected_total_raw: '125000000',
    payout_receiver_address: PAYOUT,
    approval_requested_at: new Date('2026-04-15T09:00:00.000Z'),
    approval_requested_by: 'operator-1',
    approved_at: new Date('2026-04-15T10:00:00.000Z'),
    approved_by: 'approver-2',
    matched_sweep_tx_hash: null,
    matched_sweep_block_number: null,
    matched_swept_at: null,
    executed_by: null,
    closed_at: null,
    closed_by: null,
    created_by: 'operator-1',
    metadata: {},
    created_at: new Date('2026-04-15T08:00:00.000Z'),
    updated_at: new Date('2026-04-15T10:00:00.000Z'),
  },
  entries: [],
  partnerHandoff: null,
  totals: {
    allocatedAmountRaw: '125000000',
    entryCount: 1,
  },
};

export const executedBatchFixture = {
  ...batchDetailFixture.batch,
  status: 'EXECUTED',
  matched_sweep_tx_hash: '0xclaim',
  matched_sweep_block_number: '101',
  matched_swept_at: new Date('2026-04-15T11:00:00.000Z'),
  executed_by: 'executor-3',
};
